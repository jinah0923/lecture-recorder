import { NextResponse } from "next/server";
import { del, get } from "@vercel/blob";
import { ApiError, GoogleGenAI, Type, createPartFromBase64, createPartFromUri, createUserContent } from "@google/genai";
import type { File as GenAiFile, Part } from "@google/genai";

// Edge, not Node.js — a plain (non-streaming) Serverless Function response
// on Vercel is held open until the whole handler returns, and once nothing
// has been written back to the client for a while, Vercel's proxy — or the
// browser's own fetch — treats the connection as dead and the client sees
// "Failed to fetch" long before a 1h lecture's transcription actually
// finishes. Edge Functions don't have that same idle-connection behavior,
// and combined with the SSE response below (see POST), bytes keep flowing
// to the client the whole time instead of going silent.
// @google/genai resolves to its browser/fetch-based build outside Node
// (see its package.json "exports"), which is what makes this swap safe.
export const runtime = "edge";
// Long lectures (2-3h) mean processing can run well past a few minutes.
// 300s is Vercel Hobby's actual maximum for a Function's total duration
// (confirmed against https://vercel.com/docs/functions/limitations, checked
// 2026-08 — Hobby's default AND ceiling are both 300s; only Pro/Enterprise
// can go higher, up to 800s or 1800s in extended-duration beta). There's no
// larger number to put here on this plan — a plan upgrade is the only way
// to raise this further for very long recordings.
export const maxDuration = 300;
// Separately, Vercel's docs note Edge Functions specifically "must begin
// sending a response within 25 seconds to maintain streaming capabilities
// beyond this period" — the periodic heartbeat below is tuned well under
// that, and the very first byte is sent synchronously before any work
// starts, so this route's time-to-first-byte is near-instant regardless of
// how long the Gemini processing that follows takes.
// This route never caches (always fresh Gemini work) — opt out of static
// optimization explicitly rather than relying on Next's implicit dynamic
// detection.
export const dynamic = "force-dynamic";

// This route no longer receives the raw audio/reference file bytes at all —
// the client uploads those to Vercel Blob first (see lib/blobUpload.ts and
// app/api/blob-upload/route.ts) and this route only receives small JSON
// pointing at the uploaded blobs by URL. A direct browser -> Gemini upload
// was tried first and rejected outright by Google's endpoint (no CORS
// support), so Blob storage is the actual bridge: this route downloads each
// blob itself (a server-to-server fetch, subject to neither browser CORS
// nor Vercel's 4.5MB request-body cap) and forwards it on to Gemini's Files
// API, deleting the transient blob once that hand-off is done. That's what
// actually solves the Vercel body-size ceiling for a 50+ minute lecture
// recording — the file's bytes never pass through this Function's own
// request body, so the platform's 4.5MB cap and this Function's duration
// budget are never in the same critical path as the multi-hundred-MB
// upload. This route's own job — the blob download/re-upload plus the
// actual STT/analysis calls — still needs the 300s budget above, since that
// part is genuinely long-running (unrelated to payload size).

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

type IncomingSlideThumbnail = {
  page: number;
  dataUrl: string;
};

type IncomingBlobRef = {
  url?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
};

type AnalyzeRequestBody = {
  audioBlob?: IncomingBlobRef;
  referenceBlobs?: unknown;
  bookmarks?: unknown;
  keywords?: unknown;
  slideThumbnails?: unknown;
};

const MODEL = "gemini-3.6-flash";
// Mirrors ReferenceDocDropzone's own cap (components/ReferenceDocDropzone.tsx)
// — enforced here too since the client-side limit is only a UX nicety, not
// something this publicly reachable route can rely on by itself.
const MAX_REFERENCE_FILES = 5;
// How long to wait for an uploaded file to finish Gemini-side processing
// (ACTIVE) before giving up.
const FILE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

const NO_SPEECH_TRANSCRIPT = "감지된 음성 내용이 없습니다.";
const NO_SPEECH_SUMMARY = "오디오에서 명확한 강의 음성을 찾을 수 없습니다.";
const NO_SPEECH_NOTE = "오디오에서 강의 내용을 확인할 수 없어 상세 강의노트를 생성하지 못했습니다.";

// Split into two independent schemas/calls (see callSttWorker/callAnalysisWorker
// below) instead of one combined response — a single call sharing one
// maxOutputTokens budget across a 30min+ verbatim transcript AND a deep,
// textbook-length lecture note reliably ran out of budget mid-transcript.
// Separating them gives each its own full token budget.
const STT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hasSpeech: {
      type: Type.BOOLEAN,
      description: "오디오에 사람이 말하는 강의 음성이 실제로 감지되었으면 true, 무음/배경음악/잡음뿐이면 false",
    },
    script: {
      type: Type.ARRAY,
      description:
        "발화 내용을 15~30초 분량의 자연스러운 1~2개 완성 문장 단위로 묶은 구간별 받아쓰기. 단어나 짧은 어절 단위로 잘게 쪼개지 말 것. 오디오 처음부터 끝까지 100% 빠짐없이.",
      items: {
        type: Type.OBJECT,
        properties: {
          startSeconds: { type: Type.NUMBER, description: "구간 시작 시각(초)" },
          endSeconds: { type: Type.NUMBER, description: "구간 종료 시각(초)" },
          text: { type: Type.STRING, description: "해당 구간(1~2문장)의 받아쓰기 텍스트" },
        },
        required: ["startSeconds", "endSeconds", "text"],
      },
    },
  },
  required: ["hasSpeech", "script"],
};

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description:
        "녹음 음성만을 기반으로 한 핵심 요약 3~5개를 '• '로 시작하는 글머리 기호 리스트로 작성 (마크다운, 줄글 문단 형태 금지)",
    },
    lectureNote: {
      type: Type.STRING,
      description:
        "강의 음성과 참고자료를 통합한 시험 대비용 상세 강의노트 (마크다운). 번호가 매겨진 대주제(## 1. ...) 구조, 본문은 일반 텍스트/불릿 기본, 강조가 필요한 항목에만 선택적으로 '> 🔥'/'> 🗣️' 콜아웃 사용",
    },
    checklist: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "학습자가 실천해야 할 과제/복습 체크리스트 문장 목록",
    },
  },
  required: ["summary", "lectureNote", "checklist"],
};

// Shared by both workers' system instructions — Gemini otherwise tends to
// reach for \rightarrow / $...$ style LaTeX for arrows and formulas, which
// this app's markdown renderer doesn't support and renders as broken raw
// syntax instead of the intended symbol.
const LATEX_BAN_RULE =
  "화살표나 기호를 작성할 때 절대 LaTeX 문법(예: \\rightarrow, $...$ 등 백슬래시 명령어나 달러 기호로 감싼 수식)을 " +
  "사용하지 마십시오. 반드시 일반 텍스트 기호(예: ->, =>, →, ≥, ≤, ±)만 사용하십시오.";

function formatTimestamp(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// "data:image/webp;base64,AAAA..." -> a Gemini inline-image Part. Slide
// thumbnails arrive this way (client-rendered canvas exports), never as an
// uploaded File, so they go in as inline base64 rather than through the
// Files API used for the audio/reference document.
function dataUrlToPart(dataUrl: string): Part | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return createPartFromBase64(match[2], match[1]);
}

// Occasionally the model double-escapes newlines inside a JSON string value
// (literal backslash+n instead of a real line break). Normalize defensively
// so downstream markdown rendering sees real newlines either way.
function fixEscapedNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

function describeGeminiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return `Gemini 모델(${MODEL})을 찾을 수 없습니다. 모델명이 올바른지, 이 API 키에서 사용 가능한 모델인지 확인해주세요. (${error.message})`;
    }
    if (error.status === 401 || error.status === 403) {
      return `Gemini API 인증에 실패했습니다. GEMINI_API_KEY가 유효한지 확인해주세요. (${error.message})`;
    }
    if (error.status === 429) {
      return "Google Gemini API 크레딧이 소진되었습니다. AI Studio에서 크레딧을 충전하거나 새 API 키를 등록해주세요.";
    }
    return `Gemini API 오류 (HTTP ${error.status}): ${error.message}`;
  }
  const message = error instanceof Error ? error.message : "AI 분석에 실패했습니다.";
  return `Gemini 분석 실패: ${message}`;
}

function parseBlobRef(raw: unknown): { url: string; fileName: string; mimeType: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as IncomingBlobRef;
  const url = typeof ref.url === "string" ? ref.url : "";
  const fileName = typeof ref.fileName === "string" ? ref.fileName : "";
  const mimeType = typeof ref.mimeType === "string" ? ref.mimeType : "";
  if (!url || !fileName) return null;
  return { url, fileName, mimeType };
}

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
// Matches @google/genai's own chunk size for the same upload protocol.
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

// @google/genai's own `ai.files.upload()` sets a literal `Content-Length`
// header on each upload chunk request (see its uploadBlobInternal) — a name
// the Fetch spec lists as forbidden for scripts to set manually. Node's
// fetch tolerates it, but Edge Runtime enforces the spec strictly and the
// request fails outright with a bare "fetch failed", no matter the file
// size (confirmed directly against this exact SDK call under `next dev`'s
// edge sandbox). So file upload is hand-rolled here against the same public
// resumable-upload REST protocol instead — every other Files/Models call
// below still goes through the SDK as normal, since it's only this one
// header on this one call that edge rejects.
async function uploadFileToGemini(
  apiKey: string,
  file: Blob,
  displayName: string,
  mimeType: string,
): Promise<GenAiFile> {
  const startResponse = await fetch(`${GEMINI_API_BASE_URL}/upload/v1beta/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { displayName } }),
  });
  if (!startResponse.ok) {
    throw new Error(`파일 업로드 세션을 시작하지 못했습니다 (HTTP ${startResponse.status}).`);
  }
  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new Error("업로드 URL을 받지 못했습니다.");
  }

  let offset = 0;
  let finalFile: GenAiFile | undefined;
  while (offset < file.size) {
    const chunkSize = Math.min(UPLOAD_CHUNK_BYTES, file.size - offset);
    const chunk = file.slice(offset, offset + chunkSize);
    const isFinalChunk = offset + chunkSize >= file.size;

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": isFinalChunk ? "upload, finalize" : "upload",
        "X-Goog-Upload-Offset": String(offset),
      },
      // No Content-Length header — fetch computes it from the Blob chunk
      // itself, which is exactly what a spec-compliant edge fetch requires.
      body: chunk,
    });
    if (!uploadResponse.ok) {
      throw new Error(`파일 업로드에 실패했습니다 (HTTP ${uploadResponse.status}).`);
    }
    offset += chunkSize;
    if (isFinalChunk) {
      const json = (await uploadResponse.json()) as { file?: GenAiFile };
      finalFile = json.file;
    }
  }

  if (!finalFile) {
    throw new Error("파일 업로드 응답을 확인하지 못했습니다.");
  }
  return finalFile;
}

// Downloads a client-uploaded Vercel Blob (server-to-server — no CORS or
// Vercel body-size constraint applies here) and re-uploads its bytes to
// Gemini's Files API, then deletes the now-unneeded blob regardless of
// whether that re-upload succeeded. The blob only ever exists to ferry
// bytes from the browser to this Function; once Gemini has them, keeping it
// around is pure storage cost.
async function downloadAndUploadToGemini(
  apiKey: string,
  blobUrl: string,
  displayName: string,
  fallbackMimeType: string,
): Promise<GenAiFile> {
  const blobResult = await get(blobUrl, { access: "private" });
  if (!blobResult) {
    throw new Error("업로드된 파일을 찾을 수 없습니다. 다시 시도해주세요.");
  }
  try {
    const fileBlob = await new Response(blobResult.stream).blob();
    const mimeType = blobResult.blob.contentType || fallbackMimeType;
    return await uploadFileToGemini(apiKey, fileBlob, displayName, mimeType);
  } finally {
    await del(blobUrl).catch(() => {});
  }
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

type RawSttResponse = { hasSpeech?: unknown; script?: unknown };
type RawAnalysisResponse = { summary?: unknown; lectureNote?: unknown; checklist?: unknown };

// Called with each raw text fragment Gemini streams back, from both workers
// concurrently — the POST handler below forwards these straight through to
// the client as SSE "chunk" events. Their content is never parsed on its own
// (each fragment is an incomplete slice of one JSON document, not valid JSON
// by itself); their only job is to keep bytes flowing so the connection
// never goes idle long enough to look dead. The full JSON is only parsed
// once each worker's stream ends, from the fully accumulated text.
type ChunkListener = (worker: "stt" | "analysis", text: string) => void;

// Worker A — STT only. Its entire maxOutputTokens budget goes toward the
// verbatim transcript alone, so a long lecture no longer competes with the
// lecture note for the same token ceiling.
async function callSttWorker(ai: GoogleGenAI, uploadedAudio: GenAiFile, onChunk: ChunkListener): Promise<RawSttResponse> {
  const systemInstruction = [
    "당신은 강의 녹음 오디오를 한 글자도 빠짐없이 받아쓰는 음성 인식(STT) 전문 어시스턴트입니다.",
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    "당신의 유일한 임무는 오디오에 실제로 발화된 내용을 정확하게 받아쓰는 것입니다 — 요약하거나 압축하거나 의역하지 마세요.",
    "script는 반드시 오디오 00:00부터 끝까지에 대한 100% 완전한 받아쓰기여야 합니다. 오디오가 길다는 이유로 " +
      "일부 구간을 생략, 압축, 요약하는 것은 절대 허용되지 않습니다.",
    LATEX_BAN_RULE,
    "오디오에 사람이 말하는 음성이 실제로 들리면 hasSpeech를 true로 설정하고 script를 처음부터 끝까지 빠짐없이 채우세요.",
    "오디오에 사람의 말소리가 없거나 무음, 배경음악, 단순 신호음/잡음뿐이어서 내용을 알아들을 수 없는 경우 " +
      "hasSpeech를 false로, script는 빈 배열로 응답하세요. 이 경우 절대로 내용을 지어내지 마세요.",
  ].join(" ");

  const userPrompt = [
    "오디오의 00:00부터 끝까지 중간에 절대 생략하지 말고 모든 대화를 타임스탬프와 함께 스크립트로 변환하세요.",
    "- script: 발화 내용을 15~30초 분량의 자연스러운 1~2개 완성 문장 단위로 묶어서 나눈 정확한 받아쓰기. " +
      "단어나 짧은 어절 단위로 지나치게 잘게 쪼개지 마세요. 각 구간은 시작/종료 시각(초 단위 숫자)과 텍스트를 포함합니다.",
    "- [전체 스크립트 필수] 오디오가 아무리 길어도 절대 중간에 생략하거나 요약하지 마세요. 오디오의 처음부터 끝까지, " +
      "발화된 모든 구간을 100% 빠짐없이 받아쓰기하세요. 분량이 많다는 이유로 특정 구간을 건너뛰거나 '...(중략)' 같은 " +
      "생략 표시를 사용하는 것은 절대 금지입니다.",
  ].join("\n");

  console.log("[transcribe-and-summarize] calling Gemini (STT worker)", {
    model: MODEL,
    audioFile: { uri: uploadedAudio.uri, mimeType: uploadedAudio.mimeType, name: uploadedAudio.name },
  });

  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: createUserContent([
      userPrompt,
      createPartFromUri(uploadedAudio.uri ?? "", uploadedAudio.mimeType ?? "audio/webm"),
    ]),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: STT_RESPONSE_SCHEMA,
      maxOutputTokens: 65536,
    },
  });

  let accumulated = "";
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new Error("안전 정책으로 인해 이 요청을 처리할 수 없습니다. 다른 파일로 시도해주세요.");
    }
    if (chunk.text) {
      accumulated += chunk.text;
      onChunk("stt", chunk.text);
    }
  }

  if (!accumulated) {
    throw new Error("AI로부터 스크립트 응답을 받지 못했습니다. 다시 시도해주세요.");
  }
  try {
    return JSON.parse(accumulated);
  } catch {
    throw new Error("스크립트 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
  }
}

// Worker B — analysis only (summary/lectureNote/checklist). Never writes a
// transcript, so its whole token budget goes toward depth and coverage of
// the lecture note instead.
async function callAnalysisWorker(
  ai: GoogleGenAI,
  uploadedAudio: GenAiFile,
  uploadedReferences: GenAiFile[],
  slideThumbnails: IncomingSlideThumbnail[],
  keywords: string[],
  bookmarkLines: string,
  onChunk: ChunkListener,
): Promise<RawAnalysisResponse> {
  const hasReference = uploadedReferences.length > 0;
  const hasSlideImages = slideThumbnails.length > 0;

  const systemInstruction = [
    "당신은 강의 녹음 오디오(및 첨부된 경우 강의 참고자료)를 분석해 시험 대비용 상세 학습 노트를 만드는 어시스턴트입니다.",
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    "당신의 임무는 오디오를 그대로 받아쓰는 것이 아니라 내용을 이해하고 정리·구조화하는 것입니다 — 전체 스크립트(받아쓰기)는 " +
      "별도의 전담 프로세스가 처리하므로 신경 쓰지 마세요.",
    "오디오와 참고자료에 실제로 있는 내용만 다루고, 추측하거나 지어내지 마세요.",
    "summary와 lectureNote는 역할이 다릅니다: summary는 음성만으로 만드는 짧은 개요이고, lectureNote는 음성과 참고자료를 " +
      "모두 반영한 상세하고 포괄적인 시험 대비 노트입니다. 두 필드를 동일한 내용으로 채우지 마세요.",
    LATEX_BAN_RULE,
    "오디오에 사람이 말하는 강의 음성이 실제로 들리면 summary/lectureNote/checklist를 모두 채우세요.",
    "오디오에 사람의 말소리가 없거나 무음, 배경음악, 단순 신호음/잡음뿐이어서 강의 내용을 알아들을 수 없는 경우 " +
      "summary와 lectureNote는 빈 문자열로, checklist는 빈 배열로 응답하세요. 이 경우 절대로 내용을 지어내지 마세요.",
  ].join(" ");

  const promptLines = [
    "첨부된 강의 녹음 오디오(및 참고자료)를 바탕으로 아래 항목을 생성해주세요. 전체 스크립트(받아쓰기)는 별도로 " +
      "처리되니 신경 쓰지 않아도 됩니다.",
    "1. summary: 녹음 음성만을 기반으로 핵심 내용 3~5개를 골라 각 줄을 '• '로 시작하는 글머리 기호 리스트로 작성하세요 " +
      "(줄글 문단 형태로 쓰지 말 것). 참고자료 내용은 여기에 포함하지 마세요.",
    "2. lectureNote: 시험 대비용 상세 강의노트 (마크다운). 아래 [상세 강의노트 작성 지침]을 반드시 따르세요.",
    "3. checklist: 학습자가 실천해야 할 과제 또는 복습해야 할 핵심 항목 목록 (문장 배열).",
    "",
    "[상세 강의노트 작성 지침] lectureNote는 summary보다 훨씬 상세하고 포괄적으로 작성하세요.",
    "- [단순 요약 절대 금지] lectureNote를 짧은 요약문으로 작성하는 것은 절대 금지합니다. 강의에 등장하는 모든 전문 용어, " +
      "구체적인 수치와 지표(예: 5일선, 30주선 등 실제 언급된 숫자·기준), 핵심 기법(예: 눌림목 매매, 박스권 돌파 등 " +
      "실제 언급된 방법론·전략명)을 단 하나도 빠짐없이 포함하세요. 대학 전공 서적이나 실전 비법서처럼 구조화되고 " +
      "깊이 있는 텍스트로 작성하세요 — 표면적으로 훑고 지나가는 개요가 아니라, 각 개념을 왜/어떻게/언제 적용하는지까지 " +
      "설명하는 수준이어야 합니다.",
    "- [포괄성] 강의 중 언급된 사소한 팁, 교수의 코멘트, 슬라이드 속 세부 텍스트/표까지 빠짐없이 모두 수록하세요.",
    "- [구조] 전체 내용을 대주제 단위로 나누어 \"## 1. 대주제명\", \"## 2. 대주제명\"처럼 번호를 매긴 H2 제목으로 구성하고, " +
      "필요하면 그 안에서 H3(###) 소제목으로 세분화하세요. 각 대주제 아래 일반적인 설명·배경지식·세부 내용은 " +
      "기본적으로 평범한 문단이나 글머리 기호(- 또는 •) 리스트로 작성하세요.",
    "- [선택적 강조] 모든 문장을 콜아웃 박스로 감싸지 마세요(도배 금지). 아래 두 경우에만 해당 문장 앞에 " +
      '"> " 를 붙인 인용(blockquote) 콜아웃으로 선택적으로 강조하세요.',
    "  > 🔥 [시험/핵심 강조]: 교수가 특별히 강조한 출제 포인트, 반드시 암기해야 할 핵심 개념",
    "  > 🗣️ [교수님 코멘트/사례]: 맥락 이해를 돕는 교수님의 예시나 인상적인 멘트",
    "  그 외 일반적인 설명은 콜아웃 없이 작성하세요.",
    "- [서식] 핵심 용어는 볼드체(**)로 강조하고, 필요한 경우 비교표(Markdown 표)를 활용해 가독성을 높이세요.",
  ];

  if (hasReference) {
    promptLines.push(
      "- [자료 연계] 강의자료에 도식/표/다이어그램이 포함된 구간을 다룰 때는 본문에 \"[슬라이드 N페이지: OO 도식 참조]\" 형태로 표기하세요. " +
        "정확한 페이지 번호를 알 수 없으면 \"[강의자료: OO 도식 참조]\"로 표기하세요. " +
        '교수가 말로 설명하지 않았지만 슬라이드/자료에만 있는 필수 개념은 "> 💡 [강의자료 보충] ..." 콜아웃으로 선택적으로 덧붙일 수 있습니다.',
    );
  } else {
    promptLines.push("- 강의자료가 첨부되지 않았으므로 음성 강의 내용만으로 최대한 상세하게 작성하세요.");
  }

  if (hasSlideImages) {
    promptLines.push(
      "- [슬라이드 사진 연동 — 이미지는 어디까지나 보조 수단] 첨부된 오디오 뒤에 강의 슬라이드 사진이 페이지 순서대로" +
        "(슬라이드 1, 슬라이드 2, ...) 이어서 제공됩니다. 제공된 PDF 슬라이드 이미지(차트, 수식, 다이어그램)를 오디오 " +
        "음성과 대조 분석하십시오. 사진 하나에 짧은 텍스트 한 줄만 적는 성의 없는 구조는 절대 금지합니다. 강의노트의 " +
        "핵심은 어디까지나 탄탄하고 상세한 텍스트 설명입니다 — 먼저 해당 개념·차트·수식을 글로 완전하게 풀어서 " +
        "설명한 뒤(위 [단순 요약 절대 금지] 지침 수준의 상세함으로), 시각적 이해가 반드시 필요한 경우에만 그 설명 " +
        "바로 아래에 보조적으로 `![슬라이드 X](slide_X)` 형식의 이미지 플레이스홀더를 삽입하십시오 (X는 해당 슬라이드의 " +
        "페이지 번호). 텍스트 설명 없이 이미지만 덩그러니 넣지 마세요. 실제로 차트/다이어그램/수식 등 시각 자료가 있어 " +
        "사진으로 보여주는 것이 학습에 도움이 되는 슬라이드에만 삽입하고, 텍스트뿐인 슬라이드에는 남용하지 마세요.",
    );
  }

  if (keywords.length > 0) {
    promptLines.push(
      "",
      "[STT 보정 지침] 다음은 이 강의의 전문 용어/고유명사 목록입니다. 발음이 비슷해 음성 인식 중 오타가 날 수 있는 단어들이니, " +
        `summary, lectureNote 작성 시 이 목록을 사전(Glossary)으로 참고하여 정확한 표기로 교정해주세요: ${keywords.join(", ")}`,
    );
  }

  if (hasReference) {
    promptLines.push(
      "",
      uploadedReferences.length > 1
        ? `[강의안 통합 지침] 오디오와 함께 강의 참고자료 ${uploadedReferences.length}개(슬라이드/문서)가 첨부되어 있습니다. 개별 자료로 따로 다루지 말고, 모두 하나의 강의 자료 묶음으로 취급해 종합적으로 활용하세요.`
        : "[강의안 통합 지침] 오디오와 함께 강의 참고자료(슬라이드/문서)가 첨부되어 있습니다.",
      "- STT 보정: 참고자료에 나오는 전문 용어와 고유명사도 사전으로 활용해 오인식을 교정하세요.",
      "- 통합 체크리스트: 교수가 음성으로 언급한 과제/공지사항뿐 아니라, 참고자료에 있는 연습문제나 반드시 암기해야 할 핵심 항목도 checklist에 포함하세요.",
    );
  }

  if (bookmarkLines) {
    promptLines.push("", `학습자가 녹음 중 남긴 타임스탬프 북마크:\n${bookmarkLines}`);
  }

  const userPrompt = promptLines.join("\n");

  const contentParts: (string | Part)[] = [
    userPrompt,
    createPartFromUri(uploadedAudio.uri ?? "", uploadedAudio.mimeType ?? "audio/webm"),
  ];
  for (const uploadedReference of uploadedReferences) {
    contentParts.push(
      createPartFromUri(uploadedReference.uri ?? "", uploadedReference.mimeType ?? "application/pdf"),
    );
  }
  // Inline (not Files API) — these are small, client-compressed thumbnails,
  // well under Gemini's inline-data limit. Sent in page order so the "슬라이드
  // 1, 슬라이드 2, ..." framing in the prompt above lines up with what the
  // model actually sees.
  const sortedThumbnails = [...slideThumbnails].sort((a, b) => a.page - b.page);
  for (const thumbnail of sortedThumbnails) {
    const part = dataUrlToPart(thumbnail.dataUrl);
    if (part) contentParts.push(part);
  }

  console.log("[transcribe-and-summarize] calling Gemini (analysis worker)", {
    model: MODEL,
    audioFile: { uri: uploadedAudio.uri, mimeType: uploadedAudio.mimeType, name: uploadedAudio.name },
    referenceFiles: uploadedReferences.map((file) => ({ uri: file.uri, mimeType: file.mimeType, name: file.name })),
    slideThumbnailCount: sortedThumbnails.length,
    promptChars: userPrompt.length,
    keywordCount: keywords.length,
    bookmarkCount: bookmarkLines ? bookmarkLines.split("\n").length : 0,
  });

  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: createUserContent(contentParts),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      maxOutputTokens: 65536,
    },
  });

  let accumulated = "";
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) {
      throw new Error("안전 정책으로 인해 이 요청을 처리할 수 없습니다. 다른 파일로 시도해주세요.");
    }
    if (chunk.text) {
      accumulated += chunk.text;
      onChunk("analysis", chunk.text);
    }
  }

  if (!accumulated) {
    throw new Error("AI로부터 분석 응답을 받지 못했습니다. 다시 시도해주세요.");
  }
  try {
    return JSON.parse(accumulated);
  } catch {
    throw new Error("분석 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
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

  let body: AnalyzeRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  // The audio must already be uploaded to Vercel Blob by the client
  // (lib/blobUpload.ts) before this route is ever called — see the file-
  // level comment above for why. Only its blob reference arrives here.
  const audioBlobRef = parseBlobRef(body.audioBlob);
  if (!audioBlobRef) {
    return NextResponse.json(
      { error: "오디오 파일 업로드 정보가 전달되지 않았습니다. 파일을 다시 첨부해주세요." },
      { status: 400 },
    );
  }

  const referenceRawList = Array.isArray(body.referenceBlobs) ? body.referenceBlobs : [];
  if (referenceRawList.length > MAX_REFERENCE_FILES) {
    return NextResponse.json(
      { error: `참고자료는 최대 ${MAX_REFERENCE_FILES}개까지만 첨부할 수 있습니다.` },
      { status: 400 },
    );
  }
  const referenceBlobRefs = referenceRawList
    .map(parseBlobRef)
    .filter((ref): ref is NonNullable<ReturnType<typeof parseBlobRef>> => ref !== null);

  let bookmarks: IncomingBookmark[] = [];
  if (Array.isArray(body.bookmarks)) {
    bookmarks = body.bookmarks;
  }

  let keywords: string[] = [];
  if (Array.isArray(body.keywords)) {
    keywords = body.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  let slideThumbnails: IncomingSlideThumbnail[] = [];
  if (Array.isArray(body.slideThumbnails)) {
    slideThumbnails = body.slideThumbnails.filter(
      (item): item is IncomingSlideThumbnail =>
        item && typeof item.page === "number" && typeof item.dataUrl === "string",
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  // Everything from here on can run long enough (Gemini generation for a 1h+
  // lecture) to sit through Vercel's idle-connection cutoff if sent back as
  // one plain JSON response — so instead this streams Server-Sent Events the
  // whole way: "chunk" events (raw Gemini stream fragments, forwarded purely
  // to keep bytes flowing — never meaningful on their own) and a final
  // "done" event carrying the exact same JSON payload this route used to
  // return directly. See ChunkListener above and the runtime/edge comment
  // below.
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      function send(event: string, data: unknown) {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      function sendChunk(worker: "stt" | "analysis", text: string) {
        send("chunk", { worker, text });
      }

      // Sent synchronously, before any Gemini work begins — Vercel's Edge
      // runtime requires a Function to begin sending its response within
      // 25s to keep streaming past that point, so time-to-first-byte here
      // is made near-zero rather than leaving it to chance.
      controller.enqueue(encoder.encode(`: stream-start\n\n`));

      // Covers the file-processing wait before either worker's own stream
      // has produced its first chunk — otherwise a large file's Gemini-side
      // processing time alone could leave the connection silent long enough
      // to look dead. Well under the 25s edge threshold above for
      // comfortable margin even if one tick is delayed.
      const heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: keepalive\n\n`));
      }, 8000);

      try {
        let uploadedAudio: GenAiFile;
        try {
          console.log("[transcribe-and-summarize] downloading audio blob and uploading to Gemini", {
            fileName: audioBlobRef.fileName,
          });
          uploadedAudio = await downloadAndUploadToGemini(
            apiKey,
            audioBlobRef.url,
            audioBlobRef.fileName,
            audioBlobRef.mimeType || "audio/webm",
          );
          uploadedAudio = await waitForFileActive(ai, uploadedAudio);
        } catch (error) {
          console.error("[transcribe-and-summarize] audio processing failed", { error });
          throw new Error(`오디오 처리 실패: ${describeGeminiError(error)}`);
        }

        const uploadedReferences: GenAiFile[] = [];
        for (const ref of referenceBlobRefs) {
          try {
            console.log("[transcribe-and-summarize] downloading reference blob and uploading to Gemini", {
              fileName: ref.fileName,
            });
            let uploadedReference = await downloadAndUploadToGemini(
              apiKey,
              ref.url,
              ref.fileName,
              ref.mimeType || "application/pdf",
            );
            uploadedReference = await waitForFileActive(ai, uploadedReference);
            uploadedReferences.push(uploadedReference);
          } catch (error) {
            console.error("[transcribe-and-summarize] reference processing failed", { error, fileName: ref.fileName });
            await deleteUploadedFile(ai, uploadedAudio);
            await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
            throw new Error(`참고자료 '${ref.fileName}' 처리 실패: ${describeGeminiError(error)}`);
          }
        }

        const bookmarkLines = bookmarks
          .map((bookmark) => `- [${formatTimestamp(bookmark.atMs)}] ${bookmark.label}`)
          .join("\n");

        // Two independent Gemini calls in parallel — see callSttWorker/
        // callAnalysisWorker above for why this replaced the old single
        // combined call. Both reference the same already-uploaded audio
        // file (no re-upload), and both now stream their own output back
        // as "chunk" events via sendChunk as soon as the first one starts
        // producing tokens, well before the heartbeat above would fire again.
        let sttResult: RawSttResponse;
        let analysisResult: RawAnalysisResponse;
        try {
          [sttResult, analysisResult] = await Promise.all([
            callSttWorker(ai, uploadedAudio, sendChunk),
            callAnalysisWorker(ai, uploadedAudio, uploadedReferences, slideThumbnails, keywords, bookmarkLines, sendChunk),
          ]);
        } catch (error) {
          console.error("[transcribe-and-summarize] Gemini call failed", {
            model: MODEL,
            status: error instanceof ApiError ? error.status : undefined,
            error,
          });
          throw new Error(describeGeminiError(error));
        } finally {
          // Best-effort cleanup — Files API entries auto-expire after 48h
          // anyway, so a failed delete here isn't worth surfacing to the user.
          await deleteUploadedFile(ai, uploadedAudio);
          await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
        }

        const rawSegments = Array.isArray(sttResult.script) ? sttResult.script : [];
        // The STT worker is authoritative for hasSpeech — it's the one that
        // actually listened through the whole file. If it found no speech,
        // the analysis worker's output (which may have run against the
        // reference PDF regardless) is discarded rather than risking
        // fabricated notes.
        const hasSpeech = sttResult.hasSpeech === true && rawSegments.length > 0;

        if (!hasSpeech) {
          send("done", {
            transcript: [{ id: "seg-0", startMs: 0, endMs: 0, text: NO_SPEECH_TRANSCRIPT }],
            fullText: NO_SPEECH_TRANSCRIPT,
            summary: NO_SPEECH_SUMMARY,
            lectureNote: NO_SPEECH_NOTE,
            checklist: [],
          });
          return;
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
        const summary =
          typeof analysisResult.summary === "string" ? fixEscapedNewlines(analysisResult.summary.trim()) : "";
        const lectureNote =
          typeof analysisResult.lectureNote === "string" ? fixEscapedNewlines(analysisResult.lectureNote.trim()) : "";
        const checklistTexts = Array.isArray(analysisResult.checklist)
          ? analysisResult.checklist.filter((item): item is string => typeof item === "string")
          : [];
        const checklist: ChecklistItem[] = checklistTexts.map((text, index) => ({
          id: `check-${index}`,
          text: fixEscapedNewlines(text),
          done: false,
        }));

        send("done", { transcript, fullText, summary, lectureNote, checklist });
      } catch (error) {
        send("error", { error: error instanceof Error ? error.message : "AI 분석에 실패했습니다." });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
