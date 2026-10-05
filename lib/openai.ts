// Server-side OpenAI calls for the user-selected "OpenAI" analysis engine
// (app/api/transcribe-openai). Plain fetch against the REST API — two
// endpoints don't justify another SDK dependency.

import { ANALYSIS_FIELD_DESCRIPTIONS } from "@/lib/analysisPrompt";
import type { CheckpointSegment, RawAnalysisResponse } from "@/lib/analysisPipeline";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_STT_MODEL = "whisper-1";
// Overridable without a code change — gpt-4o-mini caps output at 16,384
// tokens, which a very long lossless note can hit (see MAX_TOKENS handling
// in analyzeWithOpenAi).
export function openAiAnalysisModel(): string {
  return process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-4o-mini";
}
function openAiMaxOutputTokens(): number {
  const configured = Number(process.env.OPENAI_ANALYSIS_MAX_TOKENS);
  return Number.isFinite(configured) && configured > 0 ? configured : 16_384;
}
// Whisper's own per-file upload limit.
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;

export function openAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export const OPENAI_KEY_MISSING_MESSAGE =
  "서버에 OPENAI_API_KEY가 설정되어 있지 않아 OpenAI 엔진을 사용할 수 없습니다. .env.local(로컬) 또는 Vercel 환경 변수에 " +
  "OPENAI_API_KEY를 추가한 뒤 다시 배포해주세요.";

async function describeOpenAiFailure(response: Response, what: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: unknown; code?: unknown } } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : "";
  const code = `HTTP ${response.status}${typeof body?.error?.code === "string" ? ` ${body.error.code}` : ""}`;
  if (response.status === 401) return `OpenAI API 인증에 실패했습니다. OPENAI_API_KEY를 확인해주세요. (${code}: ${message})`;
  if (response.status === 429) {
    return `OpenAI API 사용 한도를 초과했습니다 (${code}). 잠시 후 다시 시도하거나 OpenAI 결제·한도 설정을 확인해주세요. OpenAI 응답: ${message}`;
  }
  if (response.status === 404) return `OpenAI 모델을 찾을 수 없습니다 (${code}). OPENAI_ANALYSIS_MODEL 설정을 확인해주세요. ${message}`;
  if (response.status >= 500) return `OpenAI 서버 오류로 ${what}에 실패했습니다. 잠시 후 다시 시도해주세요. (${code}: ${message})`;
  return `OpenAI ${what} 요청이 실패했습니다 (${code}): ${message}`;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

// Whisper picks the decoder from the file extension, so make sure there is
// a supported one even when the original name lacks it.
function whisperFileName(fileName: string, mimeType: string): string {
  if (/\.(flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|wav|webm)$/i.test(fileName)) return fileName;
  const extension = EXTENSION_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()] ?? "webm";
  return `${fileName || "audio"}.${extension}`;
}

type WhisperSegment = { start?: unknown; end?: unknown; text?: unknown; no_speech_prob?: unknown; avg_logprob?: unknown };

// Whisper's segments run a few seconds each; the rest of the app (and the
// Gemini engine) works in 15~30s sentence groups, so merge to match.
function groupWhisperSegments(segments: WhisperSegment[]): CheckpointSegment[] {
  const grouped: CheckpointSegment[] = [];
  let current: CheckpointSegment | null = null;
  for (const segment of segments) {
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    const start = Number(segment.start ?? 0);
    const end = Number(segment.end ?? start);
    // Whisper's usual silence signature — it otherwise tends to invent a
    // stock phrase ("시청해주셔서 감사합니다") over silent stretches.
    const looksSilent = Number(segment.no_speech_prob ?? 0) > 0.6 && Number(segment.avg_logprob ?? 0) < -1;
    if (!text || looksSilent) continue;
    if (!current) {
      current = { startSeconds: start, endSeconds: end, text };
    } else {
      current.endSeconds = end;
      current.text = `${current.text} ${text}`;
    }
    const duration = current.endSeconds - current.startSeconds;
    if ((duration >= 15 && /[.?!。…]$|[다요죠까]$/.test(current.text)) || duration >= 30) {
      grouped.push(current);
      current = null;
    }
  }
  if (current) grouped.push(current);
  return grouped;
}

// One audio file (a whole short recording or one browser-made chunk) ->
// timestamped segments relative to the file's own start.
export async function transcribeWithWhisper(
  apiKey: string,
  audio: Blob,
  fileName: string,
  mimeType: string,
  keywords: string[],
): Promise<{ hasSpeech: boolean; segments: CheckpointSegment[] }> {
  if (audio.size > WHISPER_MAX_BYTES) {
    throw new Error(
      `오디오 파일이 ${(audio.size / 1024 / 1024).toFixed(1)}MB로 OpenAI 음성 인식 한도(25MB)를 넘습니다. 다시 시도하면 ` +
        "브라우저에서 더 작게 나눠 보냅니다 — 계속 실패하면 Gemini 엔진을 사용해주세요.",
    );
  }
  const form = new FormData();
  form.append("file", new File([audio], whisperFileName(fileName, mimeType), { type: mimeType || "audio/webm" }));
  form.append("model", OPENAI_STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  // Whisper's prompt is a spelling hint, capped at ~224 tokens — the
  // learner's own glossary is exactly what it's for.
  if (keywords.length > 0) form.append("prompt", keywords.join(", ").slice(0, 600));

  const response = await fetch(`${OPENAI_API_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(await describeOpenAiFailure(response, "음성 인식(Whisper)"));
  const data = (await response.json()) as { segments?: WhisperSegment[] };
  const segments = groupWhisperSegments(Array.isArray(data.segments) ? data.segments : []);
  return { hasSpeech: segments.length > 0, segments };
}

const ANALYSIS_JSON_SCHEMA = {
  name: "lecture_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: ANALYSIS_FIELD_DESCRIPTIONS.summary },
      lectureNote: { type: "string", description: ANALYSIS_FIELD_DESCRIPTIONS.lectureNote },
      checklist: { type: "array", items: { type: "string" }, description: ANALYSIS_FIELD_DESCRIPTIONS.checklist },
    },
    required: ["summary", "lectureNote", "checklist"],
    additionalProperties: false,
  },
};

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "low" } };

export async function analyzeWithOpenAi(
  apiKey: string,
  systemInstruction: string,
  userPrompt: string,
  imageDataUrls: string[],
): Promise<RawAnalysisResponse> {
  const model = openAiAnalysisModel();
  const content: ChatContentPart[] = [{ type: "text", text: userPrompt }];
  // "low" detail: a fixed, small token cost per image — at full detail a
  // handful of photos alone would crowd the transcript out of gpt-4o-mini's
  // context window.
  for (const url of imageDataUrls) content.push({ type: "image_url", image_url: { url, detail: "low" } });

  const response = await fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content },
      ],
      response_format: { type: "json_schema", json_schema: ANALYSIS_JSON_SCHEMA },
      max_completion_tokens: openAiMaxOutputTokens(),
    }),
  });
  if (!response.ok) throw new Error(await describeOpenAiFailure(response, "강의노트 분석"));

  const data = (await response.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  };
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) {
    throw new Error(`OpenAI가 이 강의 내용의 분석을 거부했습니다: ${choice.message.refusal}`);
  }
  if (choice?.finish_reason === "length") {
    throw new Error(
      `강의노트가 ${model}의 최대 출력 길이(${openAiMaxOutputTokens().toLocaleString()} 토큰)에 도달해 잘렸습니다. 녹음이 매우 ` +
        "길다면 Gemini 엔진을 사용하거나, 서버의 OPENAI_ANALYSIS_MODEL / OPENAI_ANALYSIS_MAX_TOKENS를 더 긴 출력을 지원하는 " +
        "모델로 바꿔주세요. (음성 인식 결과는 저장되어 있어 다시 시도하면 바로 이어서 분석합니다.)",
    );
  }
  if (choice?.finish_reason === "content_filter") {
    throw new Error("OpenAI 콘텐츠 정책에 의해 강의노트 생성이 중단되었습니다 (finish_reason: content_filter).");
  }
  const text = choice?.message?.content;
  if (!text) throw new Error("OpenAI로부터 강의노트 분석 응답을 받지 못했습니다. 다시 시도해주세요.");
  try {
    return JSON.parse(text) as RawAnalysisResponse;
  } catch {
    throw new Error("OpenAI 분석 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
  }
}
