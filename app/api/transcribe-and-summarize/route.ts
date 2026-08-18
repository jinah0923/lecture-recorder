import { NextResponse } from "next/server";
import { GoogleGenAI, Type, createPartFromUri, createUserContent } from "@google/genai";
import type { File as GenAiFile } from "@google/genai";

export const runtime = "nodejs";
// Long lectures (2-3h) mean upload + processing can run well past a few
// minutes; keep this generous. (Serverless hosts with a hard function-time
// ceiling, e.g. Vercel Hobby's 300s, will still cap this regardless of the
// value here — bump the hosting plan if that applies.)
export const maxDuration = 800;

type IncomingBookmark = {
  id: string;
  label: string;
  atMs: number;
};

type TranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

const MODEL = "gemini-1.5-flash";
// Files are uploaded via the Gemini Files API (not inline base64), which
// supports up to 2GB per file — so these caps are just sane upper bounds for
// a lecture recording (2-3h of Opus audio) and a reference document, not a
// workaround for Gemini's much smaller ~20MB inline-data limit.
const MAX_AUDIO_BYTES = 300 * 1024 * 1024; // 300MB
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024; // 50MB
// How long to wait for an uploaded file to finish Gemini-side processing
// (ACTIVE) before giving up.
const FILE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

const NO_SPEECH_TRANSCRIPT = "감지된 음성 내용이 없습니다.";
const NO_SPEECH_SUMMARY = "오디오에서 명확한 강의 음성을 찾을 수 없습니다.";
const NO_SPEECH_NOTE = "오디오에서 강의 내용을 확인할 수 없어 상세 강의노트를 생성하지 못했습니다.";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hasSpeech: {
      type: Type.BOOLEAN,
      description: "오디오에 사람이 말하는 강의 음성이 실제로 감지되었으면 true, 무음/배경음악/잡음뿐이면 false",
    },
    transcript: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER, description: "구간 시작 시각(초)" },
          endSeconds: { type: Type.NUMBER, description: "구간 종료 시각(초)" },
          text: { type: Type.STRING, description: "해당 구간의 받아쓰기 텍스트" },
        },
        required: ["startSeconds", "endSeconds", "text"],
      },
    },
    summary: {
      type: Type.STRING,
      description: "녹음 음성만을 기반으로 한 3~5줄 내외의 빠른 강의 주제 및 핵심 개요 (마크다운)",
    },
    lectureNote: {
      type: Type.STRING,
      description: "강의 음성과 참고자료를 통합한 시험 대비용 상세 강의노트 (마크다운, 표/콜아웃 활용)",
    },
    checklist: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "학습자가 실천해야 할 과제/복습 체크리스트 문장 목록",
    },
  },
  required: ["hasSpeech", "transcript", "summary", "lectureNote", "checklist"],
};

function formatTimestamp(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// MediaRecorder typically reports a mimeType like "audio/webm;codecs=opus" —
// Gemini expects a bare MIME type for inline data, so strip any parameters.
function normalizeMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0].trim();
  return base || "application/octet-stream";
}

// Occasionally the model double-escapes newlines inside a JSON string value
// (literal backslash+n instead of a real line break). Normalize defensively
// so downstream markdown rendering sees real newlines either way.
function fixEscapedNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

// Uploaded files start in PROCESSING and must reach ACTIVE before they can
// be referenced in a generateContent call.
async function waitForFileActive(ai: GoogleGenAI, file: GenAiFile): Promise<GenAiFile> {
  const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
  let current = file;
  while (current.state === "PROCESSING") {
    if (Date.now() > deadline) {
      throw new Error("파일 처리 시간이 초과되었습니다. 다시 시도해주세요.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (!current.name) break;
    current = await ai.files.get({ name: current.name });
  }
  if (current.state === "FAILED") {
    throw new Error("파일 업로드 처리에 실패했습니다.");
  }
  return current;
}

async function deleteUploadedFile(ai: GoogleGenAI, file: GenAiFile | null): Promise<void> {
  if (!file?.name) return;
  try {
    await ai.files.delete({ name: file.name });
  } catch {
    // non-critical — files auto-expire after 48h regardless
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. .env.local을 확인해주세요." },
      { status: 500 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const audioFile = formData.get("audio");
  if (!(audioFile instanceof File)) {
    return NextResponse.json({ error: "오디오 파일이 전달되지 않았습니다." }, { status: 400 });
  }

  if (audioFile.size === 0) {
    return NextResponse.json({ error: "오디오 파일이 비어 있습니다. 다시 녹음하거나 업로드해주세요." }, { status: 400 });
  }

  if (audioFile.size > MAX_AUDIO_BYTES) {
    const sizeMb = (audioFile.size / (1024 * 1024)).toFixed(1);
    const maxMb = MAX_AUDIO_BYTES / (1024 * 1024);
    return NextResponse.json(
      {
        error: `오디오 파일 용량이 너무 큽니다 (최대 ${maxMb}MB, 현재 ${sizeMb}MB). 더 짧게 녹음하거나 파일을 나눠서 업로드해주세요.`,
      },
      { status: 413 },
    );
  }

  const referenceFile = formData.get("reference");
  const hasReference = referenceFile instanceof File && referenceFile.size > 0;
  if (hasReference && (referenceFile as File).size > MAX_REFERENCE_BYTES) {
    const sizeMb = ((referenceFile as File).size / (1024 * 1024)).toFixed(1);
    const maxMb = MAX_REFERENCE_BYTES / (1024 * 1024);
    return NextResponse.json(
      { error: `참고자료 파일 용량이 너무 큽니다 (최대 ${maxMb}MB, 현재 ${sizeMb}MB).` },
      { status: 413 },
    );
  }

  let bookmarks: IncomingBookmark[] = [];
  const bookmarksRaw = formData.get("bookmarks");
  if (typeof bookmarksRaw === "string" && bookmarksRaw.length > 0) {
    try {
      const parsed = JSON.parse(bookmarksRaw);
      if (Array.isArray(parsed)) bookmarks = parsed;
    } catch {
      // ignore malformed bookmarks, proceed without them
    }
  }

  let keywords: string[] = [];
  const keywordsRaw = formData.get("keywords");
  if (typeof keywordsRaw === "string" && keywordsRaw.length > 0) {
    try {
      const parsed = JSON.parse(keywordsRaw);
      if (Array.isArray(parsed)) {
        keywords = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      }
    } catch {
      // ignore malformed keywords, proceed without them
    }
  }

  const ai = new GoogleGenAI({ apiKey });

  // Large lecture recordings (2-3h) and reference docs go through the Files
  // API (upload once, reference by URI) instead of inline base64 — inline
  // data tops out around ~20MB per request, far too small for a full lecture.
  let uploadedAudio: GenAiFile;
  try {
    uploadedAudio = await ai.files.upload({
      file: audioFile,
      config: { mimeType: normalizeMimeType(audioFile.type || "audio/webm"), displayName: audioFile.name },
    });
    uploadedAudio = await waitForFileActive(ai, uploadedAudio);
  } catch (error) {
    const message = error instanceof Error ? error.message : "오디오 업로드에 실패했습니다.";
    return NextResponse.json({ error: `오디오 처리 실패: ${message}` }, { status: 502 });
  }

  let uploadedReference: GenAiFile | null = null;
  if (hasReference) {
    try {
      const refFile = referenceFile as File;
      uploadedReference = await ai.files.upload({
        file: refFile,
        config: { mimeType: normalizeMimeType(refFile.type || "application/pdf"), displayName: refFile.name },
      });
      uploadedReference = await waitForFileActive(ai, uploadedReference);
    } catch (error) {
      const message = error instanceof Error ? error.message : "참고자료 업로드에 실패했습니다.";
      await deleteUploadedFile(ai, uploadedAudio);
      return NextResponse.json({ error: `참고자료 처리 실패: ${message}` }, { status: 502 });
    }
  }

  const bookmarkLines = bookmarks
    .map((bookmark) => `- [${formatTimestamp(bookmark.atMs)}] ${bookmark.label}`)
    .join("\n");

  const systemInstruction = [
    "당신은 강의 녹음 오디오(및 첨부된 경우 강의 참고자료)를 분석해 정확한 학습 노트를 만드는 어시스턴트입니다.",
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    "오디오와 참고자료에 실제로 있는 내용만 다루고, 추측하거나 지어내지 마세요.",
    "summary와 lectureNote는 역할이 다릅니다: summary는 음성만으로 만드는 짧은 개요이고, lectureNote는 음성과 참고자료를 모두 반영한 상세하고 포괄적인 시험 대비 노트입니다. 두 필드를 동일한 내용으로 채우지 마세요.",
    "오디오에 사람이 말하는 강의 음성이 실제로 들리면 hasSpeech를 true로 설정하고 transcript/summary/lectureNote/checklist를 모두 채우세요.",
    "오디오에 사람의 말소리가 없거나 무음, 배경음악, 단순 신호음/잡음뿐이어서 강의 내용을 알아들을 수 없는 경우 hasSpeech를 false로 설정하고 transcript와 checklist는 빈 배열로, summary와 lectureNote는 빈 문자열로 응답하세요. 이 경우 절대로 내용을 지어내지 마세요.",
  ].join(" ");

  const promptLines = [
    "첨부된 강의 녹음 오디오를 듣고 아래 항목을 생성해주세요.",
    "1. hasSpeech: 오디오에 실제 강의 음성이 있는지 여부.",
    "2. transcript: 발화 구간별로 나눈 정확한 받아쓰기. 각 구간은 시작/종료 시각(초 단위 숫자)과 텍스트를 포함합니다.",
    "3. summary: 녹음 음성만을 기반으로 한 3~5줄 내외의 빠른 강의 주제 및 핵심 개요 (마크다운). 참고자료 내용은 여기에 포함하지 마세요.",
    "4. lectureNote: 시험 대비용 상세 강의노트 (마크다운). 아래 [상세 강의노트 작성 지침]을 반드시 따르세요.",
    "5. checklist: 학습자가 실천해야 할 과제 또는 복습해야 할 핵심 항목 목록 (문장 배열).",
    "",
    "[상세 강의노트 작성 지침] lectureNote는 summary보다 훨씬 상세하고 포괄적으로 작성하세요.",
    "- [포괄성] 강의 중 언급된 사소한 팁, 교수의 코멘트, 슬라이드 속 세부 텍스트/표까지 빠짐없이 모두 수록하세요.",
    "- [중요도 표시] 각 항목 앞에 아래 중 알맞은 표시를 붙이세요.",
    "  🔥 [시험/핵심 강조]: 교수가 강조한 출제 포인트, 핵심 개념",
    "  💡 [강의자료 보충]: 교수가 말로 설명하지 않았지만 슬라이드/자료에 있는 필수 개념이나 도표 설명",
    "  🗣️ [교수님 코멘트/사례]: 맥락 이해를 돕는 예시나 사소한 멘트",
    "- [서식] Markdown H2(##)/H3(###) 제목, 글머리 기호, 핵심 용어 볼드체(**), 필요한 경우 비교표(Markdown 표)를 적극 활용해 가독성을 높이세요.",
  ];

  if (hasReference) {
    promptLines.push(
      "- [자료 연계] 강의자료에 도식/표/다이어그램이 포함된 구간을 다룰 때는 본문에 \"[슬라이드 N페이지: OO 도식 참조]\" 형태로 표기하세요. " +
        "정확한 페이지 번호를 알 수 없으면 \"[강의자료: OO 도식 참조]\"로 표기하세요.",
    );
  } else {
    promptLines.push("- 강의자료가 첨부되지 않았으므로 음성 강의 내용만으로 최대한 상세하게 작성하세요.");
  }

  if (keywords.length > 0) {
    promptLines.push(
      "",
      "[STT 보정 지침] 다음은 이 강의의 전문 용어/고유명사 목록입니다. 발음이 비슷해 음성 인식 중 오타가 날 수 있는 단어들이니, " +
        `transcript, summary, lectureNote 작성 시 이 목록을 사전(Glossary)으로 참고하여 정확한 표기로 교정해주세요: ${keywords.join(", ")}`,
    );
  }

  if (hasReference) {
    promptLines.push(
      "",
      "[강의안 통합 지침] 오디오와 함께 강의 참고자료(슬라이드/문서)가 첨부되어 있습니다.",
      "- STT 보정: 참고자료에 나오는 전문 용어와 고유명사도 사전으로 활용해 음성 인식 오류를 교정하세요.",
      "- 통합 체크리스트: 교수가 음성으로 언급한 과제/공지사항뿐 아니라, 참고자료에 있는 연습문제나 반드시 암기해야 할 핵심 항목도 checklist에 포함하세요.",
    );
  }

  if (bookmarkLines) {
    promptLines.push("", `학습자가 녹음 중 남긴 타임스탬프 북마크:\n${bookmarkLines}`);
  }

  const userPrompt = promptLines.join("\n");

  const contentParts = [
    userPrompt,
    createPartFromUri(uploadedAudio.uri ?? "", uploadedAudio.mimeType ?? "audio/webm"),
  ];
  if (uploadedReference) {
    contentParts.push(
      createPartFromUri(uploadedReference.uri ?? "", uploadedReference.mimeType ?? "application/pdf"),
    );
  }

  let responseText: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent(contentParts),
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "안전 정책으로 인해 이 요청을 처리할 수 없습니다. 다른 파일로 시도해주세요." },
        { status: 502 },
      );
    }

    responseText = response.text;
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 분석에 실패했습니다.";
    return NextResponse.json({ error: `Gemini 분석 실패: ${message}` }, { status: 502 });
  } finally {
    // Best-effort cleanup — Files API entries auto-expire after 48h anyway,
    // so a failed delete here isn't worth surfacing to the user.
    await deleteUploadedFile(ai, uploadedAudio);
    if (uploadedReference) await deleteUploadedFile(ai, uploadedReference);
  }

  if (!responseText) {
    return NextResponse.json({ error: "AI로부터 응답을 받지 못했습니다. 다시 시도해주세요." }, { status: 502 });
  }

  let parsed: {
    hasSpeech?: unknown;
    transcript?: unknown;
    summary?: unknown;
    lectureNote?: unknown;
    checklist?: unknown;
  };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return NextResponse.json({ error: "AI 응답을 해석하는 데 실패했습니다. 다시 시도해주세요." }, { status: 502 });
  }

  const rawSegments = Array.isArray(parsed.transcript) ? parsed.transcript : [];
  const hasSpeech = parsed.hasSpeech === true && rawSegments.length > 0;

  if (!hasSpeech) {
    return NextResponse.json({
      transcript: [{ id: "seg-0", startMs: 0, endMs: 0, text: NO_SPEECH_TRANSCRIPT }],
      fullText: NO_SPEECH_TRANSCRIPT,
      summary: NO_SPEECH_SUMMARY,
      lectureNote: NO_SPEECH_NOTE,
      checklist: [],
    });
  }

  const transcript: TranscriptSegment[] = rawSegments.map((segment, index) => {
    const s = segment as { startSeconds?: unknown; endSeconds?: unknown; text?: unknown };
    return {
      id: `seg-${index}`,
      startMs: Math.round(Number(s.startSeconds ?? 0) * 1000),
      endMs: Math.round(Number(s.endSeconds ?? 0) * 1000),
      text: typeof s.text === "string" ? fixEscapedNewlines(s.text.trim()) : "",
    };
  });

  const fullText = transcript.map((segment) => segment.text).join(" ").trim();
  const summary = typeof parsed.summary === "string" ? fixEscapedNewlines(parsed.summary.trim()) : "";
  const lectureNote =
    typeof parsed.lectureNote === "string" ? fixEscapedNewlines(parsed.lectureNote.trim()) : "";
  const checklistTexts = Array.isArray(parsed.checklist)
    ? parsed.checklist.filter((item): item is string => typeof item === "string")
    : [];
  const checklist: ChecklistItem[] = checklistTexts.map((text, index) => ({
    id: `check-${index}`,
    text: fixEscapedNewlines(text),
    done: false,
  }));

  return NextResponse.json({
    transcript,
    fullText,
    summary,
    lectureNote,
    checklist,
  });
}
