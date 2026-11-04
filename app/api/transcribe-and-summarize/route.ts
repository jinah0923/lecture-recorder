import { NextResponse, after } from "next/server";
import { runWithJobDeadline } from "@/lib/jobDeadline";
import { del, get } from "@vercel/blob";
import { ApiError, GoogleGenAI } from "@google/genai";
import { PolicyBlockedError } from "@/lib/gemini";
import {
  MAX_AUDIO_CHUNKS,
  buildAnalysisResult,
  deleteSttCheckpoint,
  formatBookmarkLines,
  normalizeSttSegments,
  parseBlobRef,
  readJobRecord,
  readSttCheckpoint,
  reportStage,
  segmentsToTranscriptText,
  writeJobRecord,
  writeSttCheckpoint,
} from "@/lib/analysisPipeline";
import type {
  AnalysisResult,
  AudioChunkRef,
  BlobRef,
  CheckpointSegment,
  IncomingBookmark,
  RawAnalysisResponse,
  SttCheckpoint,
} from "@/lib/analysisPipeline";
import { blockedChunkTranscriptText } from "@/lib/geminiMessages";
import type { BlockedChunkNotice } from "@/lib/types";
import type { File as GenAiFile } from "@google/genai";
import {
  MODEL,
  callAnalysisWorker,
  deleteUploadedFile,
  describeGeminiError,
  downloadAndUploadToGemini,
  uploadReferenceFiles,
  waitForFileActive,
} from "@/lib/geminiAnalysis";
import type { IncomingSlideThumbnail } from "@/lib/geminiAnalysis";
import { callSttWorker } from "@/lib/geminiStt";
import type { RawSttResponse } from "@/lib/geminiStt";
import { isRedisConfigured } from "@/lib/redis";

// Node.js, not Edge — this route now talks to Redis via ioredis (see
// lib/redis.ts) for job tracking, and ioredis needs a real TCP socket
// (node:net/tls), which Edge Runtime's isolate doesn't expose at all. The
// earlier reason for Edge here — keeping a long SSE response streaming
// without Vercel's proxy or the browser killing an idle connection — no
// longer applies either: see the architecture note below.
export const runtime = "nodejs";
// Long lectures (2-3h) mean the background job (see after() in POST) can
// run well past a few minutes. 300s is Vercel Hobby's actual maximum for a
// Function's total duration on the Node.js runtime too (confirmed against
// https://vercel.com/docs/functions/limitations, checked 2026-08 — Hobby's
// default AND ceiling are both 300s regardless of runtime). There's no
// larger number to put here on this plan — a plan upgrade is the only way
// to raise this further for very long recordings.
export const maxDuration = 300;
// This route never caches (always fresh Gemini work) — opt out of static
// optimization explicitly rather than relying on Next's implicit dynamic
// detection.
export const dynamic = "force-dynamic";

// Architecture: async job queue, not a held-open request.
//
// Mobile browsers aggressively suspend a backgrounded tab's network
// connections — switching away from the app mid-analysis (or the OS just
// deciding to reclaim the tab) killed the in-flight request outright and
// surfaced as "network error" client-side, no matter how well-behaved the
// server's own response was (this app had already gone through an Edge +
// SSE-streaming iteration specifically to dodge server/proxy-side idle-
// connection kills — see git history — but that never addressed the client
// connection itself being suspended, which is a different failure mode
// streaming can't fix).
//
// So the request/response lifecycle here is now deliberately short:
// POST creates a job, kicks off the real work via after() (Next.js's
// primitive for continuing work past the point the response was sent —
// Vercel implements it with waitUntil(), bounded by the same maxDuration
// above), and returns just a jobId, fast. The client never holds a
// connection open for the actual analysis at all — instead it polls GET
// with that jobId (see lib/analysisJob.ts), and RecordingDetailView.tsx
// persists the jobId to localStorage so a closed/backgrounded/reopened tab
// can resume polling and safely pick up whatever Redis has, including a
// result that finished while nobody was watching.
//
// Audio/reference files still never touch this Function's own request body
// (see the Vercel Blob relay below) — that part of the architecture is
// unchanged, just no longer entangled with the connection-liveness problem.

type IncomingBlobRef = {
  url?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
};

type AnalyzeRequestBody = {
  // Identifies the recording across separate job attempts — required so a
  // retry can find its predecessor's STT checkpoint (see SttCheckpoint).
  // Not a jobId: a fresh jobId is minted per POST regardless, but the
  // checkpoint has to outlive any single attempt to be resumable at all.
  sessionId?: unknown;
  // Optional when a checkpoint already exists for this sessionId — a
  // checkpoint resume never touches the original audio (see
  // runAnalysisOnlyFromCheckpoint), so the client skips re-uploading it
  // entirely on retry (see lib/analysisJob.ts's checkSttCheckpoint).
  audioBlob?: IncomingBlobRef;
  referenceBlobs?: unknown;
  bookmarks?: unknown;
  keywords?: unknown;
  slideThumbnails?: unknown;
  // Present instead of audioBlob for long recordings the browser split up
  // (see lib/audioChunking.ts). startMs is each piece's offset into the
  // original recording, used to shift its transcript timestamps back.
  audioChunks?: unknown;
};

// Mirrors ReferenceDocDropzone's own cap (components/ReferenceDocDropzone.tsx)
// — enforced here too since the client-side limit is only a UX nicety, not
// something this publicly reachable route can rely on by itself.
const MAX_REFERENCE_FILES = 5;

// The path for recordings the browser did not need to split (a single
// audioBlob, see lib/audioChunking.ts CHUNK_THRESHOLD_MS): the whole
// audio file goes to Gemini once, and both workers run against it directly
// and in parallel. Runs inside after() (see POST), fully decoupled from
// whatever the client's connection is doing by that point.
async function runDirectAnalysisJob(
  apiKey: string,
  sessionId: string,
  audioBlobRef: BlobRef,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ apiKey });

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

  let uploadedReferences: GenAiFile[];
  try {
    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobRefs);
  } catch (error) {
    await deleteUploadedFile(ai, uploadedAudio);
    throw error;
  }

  const bookmarkLines = formatBookmarkLines(bookmarks);

  // Two independent Gemini calls in parallel — see callSttWorker/
  // callAnalysisWorker above for why this replaced the old single combined
  // call. Both reference the same already-uploaded audio file (no re-upload).
  //
  // STAGE 1/STAGE 2 checkpointing: sttPromise's own .then() below writes the
  // STT checkpoint the instant transcription finishes, completely
  // independent of whether analysisPromise (STAGE 2) is still running or
  // later fails/times out — Promise.all rejecting on analysisPromise can
  // never "undo" a checkpoint write that already happened on sttPromise's
  // own chain. This keeps the STT and LLM calls genuinely concurrent (same
  // wall-clock time as before this feature existed) while still guaranteeing
  // the checkpoint lands the moment STT is done, not only after both finish.
  let sttResult: RawSttResponse;
  let analysisResult: RawAnalysisResponse;
  try {
    const sttPromise = callSttWorker(ai, uploadedAudio).then(async (result) => {
      const hasSpeech = result.hasSpeech === true && Array.isArray(result.script) && result.script.length > 0;
      if (hasSpeech) {
        const segments = normalizeSttSegments(result.script);
        await writeSttCheckpoint(sessionId, "gemini", {
          createdAt: Date.now(),
          transcriptText: segmentsToTranscriptText(segments),
          segments,
          hasSpeech: true,
        });
      }
      return result;
    });
    const analysisPromise = callAnalysisWorker(
      ai,
      { kind: "file", file: uploadedAudio },
      uploadedReferences,
      slideThumbnails,
      keywords,
      bookmarkLines,
    );
    [sttResult, analysisResult] = await Promise.all([sttPromise, analysisPromise]);
  } catch (error) {
    console.error("[transcribe-and-summarize] Gemini call failed", {
      model: MODEL,
      status: error instanceof ApiError ? error.status : undefined,
      error,
    });
    throw new Error(describeGeminiError(error));
  } finally {
    // Best-effort cleanup — Files API entries auto-expire after 48h anyway,
    // so a failed delete here isn't worth surfacing to the user.
    await deleteUploadedFile(ai, uploadedAudio);
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
  }

  return buildAnalysisResult(sttResult.script, sttResult.hasSpeech === true, analysisResult);
}

// The chunked path for long recordings — the browser already split the audio
// into ~20-minute pieces and uploaded each as its own blob (see
// lib/audioChunking.ts), so this Function never handles the whole
// recording at once: each piece is transcribed as its own small,
// independent STT call (in parallel — wall-clock time is what's actually
// budget-constrained here, not aggregate work), and only then does the
// analysis worker run once against the merged, already-accurate transcript
// text — not the raw audio again, which would just re-expose that worker to
// the very duration risk this path exists to avoid.
async function runChunkedAnalysisJob(
  apiKey: string,
  jobId: string,
  sessionId: string,
  audioChunks: AudioChunkRef[],
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ apiKey });
  const uploadedChunkFiles: GenAiFile[] = [];
  let uploadedReferences: GenAiFile[] = [];

  try {
    const chunks = audioChunks;
    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobRefs);

    // Each chunk gets its own small STT call, run in parallel — this is
    // what actually keeps the whole job inside the 300s function budget for
    // a very long recording; splitting the work up without also
    // parallelizing it would just replace one long call with several
    // sequential ones adding up to roughly the same wall-clock time.
    await reportStage(jobId, `청크 0/${chunks.length} 처리 중...`);
    let completedChunks = 0;
    const chunkResults = await Promise.all(
      chunks.map(async (chunk, index) => {
        // downloadAndUploadToGemini also deletes the chunk's blob once
        // Gemini has the bytes.
        const chunkFile = await downloadAndUploadToGemini(
          apiKey,
          chunk.url,
          `chunk-${index}`,
          chunk.mimeType || "audio/webm",
        );
        const activeFile = await waitForFileActive(ai, chunkFile);
        uploadedChunkFiles.push(activeFile);
        // null = Gemini refused this chunk (PROHIBITED_CONTENT). One refused
        // stretch shouldn't cost the whole lecture, so it becomes a marked
        // gap in the transcript and the rest is analyzed as usual.
        let result: RawSttResponse | null;
        try {
          result = await callSttWorker(ai, activeFile);
        } catch (error) {
          console.error("[transcribe-and-summarize] chunk STT failed", { index, error });
          if (!(error instanceof PolicyBlockedError)) {
            throw new Error(`오디오 조각 ${index + 1}/${chunks.length} 음성 인식 실패: ${describeGeminiError(error)}`);
          }
          result = null;
        }
        completedChunks += 1;
        await reportStage(jobId, `청크 ${completedChunks}/${chunks.length} 처리 중...`);
        return { chunk, index, result };
      }),
    );

    const blockedChunks: BlockedChunkNotice[] = chunkResults
      .filter(({ result }) => result === null)
      .map(({ chunk, index }) => ({
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        startMs: chunk.startMs,
        endMs: chunks[index + 1]?.startMs ?? null,
      }));
    const hasSpeech = chunkResults.some(({ result }) => result?.hasSpeech === true);
    if (!hasSpeech && blockedChunks.length > 0) {
      // Nothing left to analyze — every chunk with speech was refused.
      throw new PolicyBlockedError(
        `오디오 조각 ${blockedChunks.map((c) => `${c.chunkIndex}/${c.chunkCount}`).join(", ")} — 나머지 조각에는 음성이 없음`,
      );
    }
    const mergedSegments: CheckpointSegment[] = [];
    let segmentIndex = 0;
    // chunkResults preserves chunks' original chronological order (Promise.all
    // resolves in input order regardless of which chunk actually finished
    // first), so this merge doesn't need to re-sort anything.
    for (const { chunk, index, result } of chunkResults) {
      const offsetSeconds = chunk.startMs / 1000;
      if (result === null) {
        const nextStartMs = chunks[index + 1]?.startMs;
        mergedSegments.push({
          startSeconds: offsetSeconds,
          endSeconds: nextStartMs !== undefined ? nextStartMs / 1000 : offsetSeconds,
          text: blockedChunkTranscriptText({
            chunkIndex: index + 1,
            chunkCount: chunks.length,
            startMs: chunk.startMs,
            endMs: nextStartMs ?? null,
          }),
          source: "blocked",
        });
        segmentIndex++;
        continue;
      }
      for (const segment of normalizeSttSegments(result.script)) {
        mergedSegments.push({
          startSeconds: segment.startSeconds + offsetSeconds,
          endSeconds: segment.endSeconds + offsetSeconds,
          text: segment.text,
        });
        segmentIndex++;
      }
    }
    console.log("[transcribe-and-summarize] merged chunked transcript", {
      chunkCount: chunks.length,
      mergedSegmentCount: segmentIndex,
      hasSpeech,
      blockedChunkCount: blockedChunks.length,
    });

    if (!hasSpeech) {
      return buildAnalysisResult([], false, {});
    }

    // STAGE 1 (STT, chunked) complete — checkpoint immediately, before
    // STAGE 2 (LLM analysis) below ever runs, so a stage-2 timeout/failure
    // never forces every chunk to be re-split, re-uploaded, and
    // re-transcribed on retry (see runAnalysisOnlyFromCheckpoint).
    const transcriptText = segmentsToTranscriptText(mergedSegments);
    await writeSttCheckpoint(sessionId, "gemini", {
      createdAt: Date.now(),
      transcriptText,
      segments: mergedSegments,
      hasSpeech: true,
      ...(blockedChunks.length > 0 ? { blockedChunks } : {}),
    });

    await reportStage(jobId, "AI 요약 생성 중...");

    const bookmarkLines = formatBookmarkLines(bookmarks);

    let analysisResult: RawAnalysisResponse;
    try {
      analysisResult = await callAnalysisWorker(
        ai,
        { kind: "transcript", text: transcriptText },
        uploadedReferences,
        slideThumbnails,
        keywords,
        bookmarkLines,
      );
    } catch (error) {
      console.error("[transcribe-and-summarize] chunked analysis worker failed", {
        model: MODEL,
        status: error instanceof ApiError ? error.status : undefined,
        error,
      });
      throw new Error(describeGeminiError(error));
    }

    return buildAnalysisResult(mergedSegments, hasSpeech, analysisResult, { blockedChunks });
  } finally {
    await Promise.all(uploadedChunkFiles.map((file) => deleteUploadedFile(ai, file)));
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
    // Chunk blobs normally get deleted right after download; this covers the
    // ones a failure kept us from ever reaching.
    await Promise.all(audioChunks.map((chunk) => del(chunk.url).catch(() => {})));
  }
}

// STAGE 2 only — resumes from a previously-checkpointed STT result (see
// SttCheckpoint), skipping audio download/upload/chunking/transcription
// entirely regardless of whether the original attempt was direct or
// chunked (both converge on the same {transcriptText, segments, hasSpeech}
// shape by the time a checkpoint exists). This is what actually avoids
// burning STT credits again on a retry after a stage-2-only failure — and
// since it never touches the original audio at all, it works even if the
// client no longer has it (e.g. the IndexedDB audio cache was lost too).
async function runAnalysisOnlyFromCheckpoint(
  apiKey: string,
  jobId: string,
  checkpoint: SttCheckpoint,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
): Promise<AnalysisResult> {
  const ai = new GoogleGenAI({ apiKey });
  let uploadedReferences: GenAiFile[] = [];

  try {
    await reportStage(jobId, "AI 요약 생성 중... (STT 결과 재사용)");
    uploadedReferences = await uploadReferenceFiles(ai, apiKey, referenceBlobRefs);

    const bookmarkLines = formatBookmarkLines(bookmarks);

    const analysisResult = await callAnalysisWorker(
      ai,
      { kind: "transcript", text: checkpoint.transcriptText },
      uploadedReferences,
      slideThumbnails,
      keywords,
      bookmarkLines,
    );
    return buildAnalysisResult(checkpoint.segments, checkpoint.hasSpeech, analysisResult, {
      blockedChunks: checkpoint.blockedChunks,
    });
  } catch (error) {
    console.error("[transcribe-and-summarize] checkpoint-resumed analysis worker failed", {
      model: MODEL,
      status: error instanceof ApiError ? error.status : undefined,
      error,
    });
    throw new Error(describeGeminiError(error));
  } finally {
    await Promise.all(uploadedReferences.map((file) => deleteUploadedFile(ai, file)));
  }
}

// Dispatches to: a checkpoint resume (STAGE 2 only, if a prior attempt for
// this session already completed STT — see SttCheckpoint), or else the
// chunked (browser-split audioChunks) or direct (single audioBlob) STAGE 1+2 path.
// The checkpoint check always comes first — it's what
// makes a retry after a stage-2 failure skip STT regardless of how long the
// recording is.
async function runAnalysisJob(
  apiKey: string,
  jobId: string,
  sessionId: string,
  audioBlobRef: BlobRef | null,
  referenceBlobRefs: BlobRef[],
  bookmarks: IncomingBookmark[],
  keywords: string[],
  slideThumbnails: IncomingSlideThumbnail[],
  audioChunks: AudioChunkRef[],
): Promise<AnalysisResult> {
  const checkpoint = await readSttCheckpoint(sessionId, "gemini");
  if (checkpoint) {
    return runAnalysisOnlyFromCheckpoint(apiKey, jobId, checkpoint, referenceBlobRefs, bookmarks, keywords, slideThumbnails);
  }
  if (audioChunks.length > 0) {
    return runChunkedAnalysisJob(apiKey, jobId, sessionId, audioChunks, referenceBlobRefs, bookmarks, keywords, slideThumbnails);
  }
  if (!audioBlobRef) {
    throw new Error("오디오 파일 업로드 정보가 없어 분석을 시작할 수 없습니다. 파일을 다시 첨부해주세요.");
  }
  return runDirectAnalysisJob(apiKey, sessionId, audioBlobRef, referenceBlobRefs, bookmarks, keywords, slideThumbnails);
}

// Kicks off a job and returns its id immediately — see the file-level
// architecture comment above.
export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. .env.local을 확인해주세요." },
      { status: 500 },
    );
  }

  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  let body: AnalyzeRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
  if (!sessionId) {
    return NextResponse.json({ error: "세션 정보가 전달되지 않았습니다." }, { status: 400 });
  }

  // The audio must already be uploaded to Vercel Blob by the client
  // (lib/blobUpload.ts) before this route is ever called. Only its blob
  // reference arrives here. Absent is only valid when a STAGE 1 checkpoint
  // already exists for this session (see runAnalysisJob) — the client
  // knows this in advance via checkSttCheckpoint and skips the upload, so
  // this is re-checked here rather than trusted from the client alone.
  const audioBlobRef = body.audioBlob ? parseBlobRef(body.audioBlob) : null;
  const rawChunks = Array.isArray(body.audioChunks) ? body.audioChunks : [];
  if (rawChunks.length > MAX_AUDIO_CHUNKS) {
    return NextResponse.json({ error: `오디오 조각은 최대 ${MAX_AUDIO_CHUNKS}개까지 지원합니다.` }, { status: 400 });
  }
  const audioChunks: AudioChunkRef[] = [];
  for (const raw of rawChunks) {
    const ref = parseBlobRef(raw);
    const startMs = (raw as { startMs?: unknown } | null)?.startMs;
    if (!ref || typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) {
      return NextResponse.json({ error: "오디오 조각 정보가 올바르지 않습니다." }, { status: 400 });
    }
    audioChunks.push({ ...ref, startMs });
  }
  audioChunks.sort((a, b) => a.startMs - b.startMs);
  if (!audioBlobRef && audioChunks.length === 0 && !(await readSttCheckpoint(sessionId, "gemini"))) {
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

  const bookmarks: IncomingBookmark[] = Array.isArray(body.bookmarks) ? body.bookmarks : [];
  const keywords: string[] = Array.isArray(body.keywords)
    ? body.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const slideThumbnails: IncomingSlideThumbnail[] = Array.isArray(body.slideThumbnails)
    ? body.slideThumbnails.filter(
        (item): item is IncomingSlideThumbnail =>
          item && typeof item.page === "number" && typeof item.dataUrl === "string",
      )
    : [];

  const jobId = crypto.randomUUID();
  await writeJobRecord(jobId, { status: "processing", createdAt: Date.now() });

  after(async () => {
    try {
      // Bounded by maxDuration — lets optional steps (continuing a cut-off
      // note, lib/noteCompletion.ts) skip themselves when time is short.
      const result = await runWithJobDeadline(maxDuration, () =>
        runAnalysisJob(
          apiKey,
          jobId,
          sessionId,
          audioBlobRef,
          referenceBlobRefs,
          bookmarks,
          keywords,
          slideThumbnails,
          audioChunks,
        ),
      );
      await writeJobRecord(jobId, { status: "completed", createdAt: Date.now(), result });
      // The checkpoint's only job was protecting against a STAGE 2 failure
      // on THIS attempt — now that the whole job has succeeded, it's dead
      // weight (and could otherwise cause a much later, unrelated re-analyze
      // of this same session to wrongly skip STT against a stale script).
      await deleteSttCheckpoint(sessionId, "gemini");
    } catch (error) {
      // Covers every error this route's own code can throw and catch —
      // Gemini failures, upload failures, all already
      // surface here via the try/catches inside runAnalysisJob's two paths.
      // What this can NEVER catch is the Function process itself being
      // killed outright (a hard maxDuration cutoff or an OOM kill) — there's
      // no JS handler for that, the process is just gone mid-flight. That's
      // exactly why the client's own poll loop (lib/analysisJob.ts) enforces
      // its own independent timeout instead of waiting on this write forever.
      console.error("[transcribe-and-summarize] job failed", { jobId, error });
      await writeJobRecord(jobId, {
        status: "error",
        createdAt: Date.now(),
        error: error instanceof Error ? error.message : "AI 분석에 실패했습니다.",
      });
    }
  });

  return NextResponse.json({ jobId });
}

// Polling endpoint — see lib/analysisJob.ts on the client side.
export async function GET(request: Request) {
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Redis 스토리지가 연결되어 있지 않습니다. Vercel 프로젝트에 Redis 통합을 연결한 뒤 다시 시도해주세요." },
      { status: 503 },
    );
  }

  const url = new URL(request.url);

  // Lets the client know, before it even starts uploading anything, whether
  // a STAGE 1 checkpoint already exists for this session — drives both the
  // "이어서 분석 재개하기" button label and skipping the (possibly large)
  // audio re-upload entirely on retry (see components/RecordingDetailView.tsx).
  const checkpointFor = url.searchParams.get("checkpointFor");
  if (checkpointFor) {
    const checkpoint = await readSttCheckpoint(checkpointFor, "gemini");
    return NextResponse.json({ hasCheckpoint: checkpoint !== null });
  }

  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId가 전달되지 않았습니다." }, { status: 400 });
  }

  const record = await readJobRecord(jobId);
  if (!record) {
    return NextResponse.json(
      { error: "작업을 찾을 수 없습니다. 만료되었거나 존재하지 않는 작업입니다." },
      { status: 404 },
    );
  }

  return NextResponse.json(record);
}
