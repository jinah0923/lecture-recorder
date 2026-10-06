// Gemini helpers for the lecture-note (analysis) step, shared by
// app/api/transcribe-and-summarize (full analysis after speech-to-text) and
// app/api/merge-material (re-analysis of an existing transcript with newly
// added reference material — no audio involved). Speech-to-text itself stays
// in transcribe-and-summarize.

import { del, get } from "@vercel/blob";
import { GoogleGenAI, Type, createPartFromBase64, createPartFromUri, createUserContent } from "@google/genai";
import type { File as GenAiFile, Part } from "@google/genai";
import type { BlobRef, RawAnalysisResponse } from "@/lib/analysisPipeline";
import { ANALYSIS_FIELD_DESCRIPTIONS, buildAnalysisPrompt } from "@/lib/analysisPrompt";
import {
  ACADEMIC_CONTEXT_INSTRUCTION,
  SAFETY_SETTINGS,
  describeGeminiError as describeSharedGeminiError,
  readResponseText,
} from "@/lib/gemini";

export const MODEL = "gemini-3.6-flash";
// How long to wait for an uploaded file to finish Gemini-side processing
// (ACTIVE) before giving up.
const FILE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

export type IncomingSlideThumbnail = {
  page: number;
  dataUrl: string;
};

const ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: ANALYSIS_FIELD_DESCRIPTIONS.summary,
    },
    lectureNote: {
      type: Type.STRING,
      description: ANALYSIS_FIELD_DESCRIPTIONS.lectureNote,
    },
    checklist: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: ANALYSIS_FIELD_DESCRIPTIONS.checklist,
    },
  },
  required: ["summary", "lectureNote", "checklist"],
};

// "data:image/webp;base64,AAAA..." -> a Gemini inline-image Part. Slide
// thumbnails arrive this way (client-rendered canvas exports), never as an
// uploaded File, so they go in as inline base64 rather than through the
// Files API used for the audio/reference document.
function dataUrlToPart(dataUrl: string): Part | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return createPartFromBase64(match[2], match[1]);
}

export function describeGeminiError(error: unknown): string {
  return describeSharedGeminiError(error, MODEL);
}

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";
// Matches @google/genai's own chunk size for the same upload protocol.
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

// @google/genai's own `ai.files.upload()` sets a literal `Content-Length`
// header on each upload chunk request (see its uploadBlobInternal) — a name
// the Fetch spec lists as forbidden for scripts to set manually. Node's own
// fetch (undici) tolerates it in practice, but this hand-rolled version
// (proven under both Edge and Node during earlier iterations of this route)
// is kept as-is rather than reverted to the SDK call, since there's no
// upside to touching working upload code while restructuring everything
// else here.
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
      // No Content-Length header — fetch computes it from the Blob chunk itself.
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
export async function downloadAndUploadToGemini(
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
export async function waitForFileActive(ai: GoogleGenAI, file: GenAiFile): Promise<GenAiFile> {
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

export async function deleteUploadedFile(ai: GoogleGenAI, file: GenAiFile | null): Promise<void> {
  if (!file?.name) return;
  try {
    await ai.files.delete({ name: file.name });
  } catch {
    // non-critical — files auto-expire after 48h regardless
  }
}

// Either the raw audio file (the normal, short-recording path) or an
// already-complete transcript string (the chunked long-recording path —
// see runChunkedAnalysisJob). The chunked STT pass already listened through
// the whole thing accurately in pieces, so re-attaching the full audio here
// too would just be redundant work exposed to the same duration risk this
// whole feature exists to avoid; the transcript is plenty for this worker's
// job of understanding and structuring content, not re-transcribing it.
export type AnalysisAudioSource = { kind: "file"; file: GenAiFile } | { kind: "transcript"; text: string };

// Worker B — analysis only (summary/lectureNote/checklist). Never writes a
// transcript, so its whole token budget goes toward depth and coverage of
// the lecture note instead.
export async function callAnalysisWorker(
  ai: GoogleGenAI,
  audioSource: AnalysisAudioSource,
  uploadedReferences: GenAiFile[],
  slideThumbnails: IncomingSlideThumbnail[],
  keywords: string[],
  bookmarkLines: string,
): Promise<RawAnalysisResponse> {
  const prompt = buildAnalysisPrompt(audioSource, uploadedReferences.length, slideThumbnails.length > 0, keywords, bookmarkLines);
  // The academic-context framing is Gemini-only (see lib/gemini.ts).
  const systemInstruction = `${ACADEMIC_CONTEXT_INSTRUCTION} ${prompt.systemInstruction}`;
  const userPrompt = prompt.userPrompt;

  const contentParts: (string | Part)[] = [userPrompt];
  if (audioSource.kind === "file") {
    contentParts.push(createPartFromUri(audioSource.file.uri ?? "", audioSource.file.mimeType ?? "audio/webm"));
  }
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
    audioSource:
      audioSource.kind === "file"
        ? { kind: "file", uri: audioSource.file.uri, mimeType: audioSource.file.mimeType, name: audioSource.file.name }
        : { kind: "transcript", chars: audioSource.text.length },
    referenceFiles: uploadedReferences.map((file) => ({ uri: file.uri, mimeType: file.mimeType, name: file.name })),
    slideThumbnailCount: sortedThumbnails.length,
    promptChars: userPrompt.length,
    keywordCount: keywords.length,
    bookmarkCount: bookmarkLines ? bookmarkLines.split("\n").length : 0,
  });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: createUserContent(contentParts),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      maxOutputTokens: 65536,
      safetySettings: SAFETY_SETTINGS,
    },
  });

  const text = readResponseText(response, "강의노트 분석");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("분석 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
  }
}

// Shared by both paths — reference docs are always uploaded whole
// regardless of how the audio itself is handled.
export async function uploadReferenceFiles(ai: GoogleGenAI, apiKey: string, referenceBlobRefs: BlobRef[]): Promise<GenAiFile[]> {
  const uploadedReferences: GenAiFile[] = [];
  for (const ref of referenceBlobRefs) {
    try {
      console.log("[transcribe-and-summarize] downloading reference blob and uploading to Gemini", {
        fileName: ref.fileName,
      });
      let uploadedReference = await downloadAndUploadToGemini(apiKey, ref.url, ref.fileName, ref.mimeType || "application/pdf");
      uploadedReference = await waitForFileActive(ai, uploadedReference);
      uploadedReferences.push(uploadedReference);
    } catch (error) {
      console.error("[transcribe-and-summarize] reference processing failed", { error, fileName: ref.fileName });
      await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
      throw new Error(`참고자료 '${ref.fileName}' 처리 실패: ${describeGeminiError(error)}`);
    }
  }
  return uploadedReferences;
}
