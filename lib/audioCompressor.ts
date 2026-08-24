"use client";

// Resamples uploaded audio down to 16kHz mono (the format STT models want)
// via Web Audio's OfflineAudioContext, then — where the browser supports it
// — Opus-encodes the result for real size reduction.
//
// Resampling alone is NOT enough to shrink a large upload: 16kHz mono 16-bit
// PCM is ~115MB/hour, which is *bigger* than a typical 44.1kHz stereo AAC/MP3
// source (often ~55-60MB/hour) since that source is already lossy-compressed
// and PCM isn't compressed at all. Only an actual lossy codec (here, Opus at
// a low bitrate — the standard choice for compressed speech) gets a 50MB+
// upload down toward the ~10MB target. Where WebCodecs isn't available
// (notably Safari, at time of writing), this falls back to a 16kHz mono WAV,
// which is still the right format for STT even though it isn't small.
//
// Either way, this never makes the upload worse: the result is only used if
// it's smaller than what came in, and any failure along the way (corrupt
// file, browser lacking a needed API) falls back to uploading the original
// file untouched rather than blocking the user.

const TARGET_SAMPLE_RATE = 16000;
// Comfortably intelligible for speech/STT at a fraction of the size —
// standard territory for compressed voice (well below music-quality Opus).
const OPUS_BITRATE = 24_000;

export type CompressAudioCodec = "opus" | "wav" | "original";

export type CompressAudioResult = {
  blob: Blob;
  mimeType: string;
  codec: CompressAudioCodec;
};

function getAudioContextConstructor(): typeof AudioContext {
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!ctor) throw new Error("이 브라우저는 오디오 처리(Web Audio API)를 지원하지 않습니다.");
  return ctor;
}

async function decodeAndResample(file: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextCtor = getAudioContextConstructor();
  const decodeCtx = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await decodeCtx.close();
  }

  // A 1-channel OfflineAudioContext destination downmixes a stereo (or
  // wider) source automatically per the Web Audio spec's standard mixing
  // rules — no manual channel math needed.
  const frameCount = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);
  return offlineCtx.startRendering();
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function encodeWav(buffer: AudioBuffer): Blob {
  const pcm = floatTo16BitPCM(buffer.getChannelData(0));
  const byteRate = buffer.sampleRate * 2;
  const dataSize = pcm.length * 2;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);

  function writeString(offset: number, text: string) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    view.setInt16(offset, pcm[i], true);
  }

  return new Blob([output], { type: "audio/wav" });
}

// Opus, muxed into WebM via WebCodecs — only available where AudioEncoder
// exists (Chromium-based browsers). Returns null on any failure or lack of
// support so the caller can fall back to encodeWav.
async function encodeOpusWebm(buffer: AudioBuffer): Promise<Blob | null> {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;

  try {
    const { Muxer, ArrayBufferTarget } = await import("webm-muxer");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      audio: { codec: "A_OPUS", sampleRate: buffer.sampleRate, numberOfChannels: 1 },
    });

    let encodeFailed = false;
    const encoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: () => {
        encodeFailed = true;
      },
    });
    encoder.configure({
      codec: "opus",
      sampleRate: buffer.sampleRate,
      numberOfChannels: 1,
      bitrate: OPUS_BITRATE,
    });

    // WebCodecs reassembles a continuous stream from whatever chunk sizes
    // are fed in — these don't need to align to Opus's own frame sizes.
    const CHUNK_FRAMES = 4800; // 300ms at 16kHz
    const channelData = buffer.getChannelData(0);
    let timestampUs = 0;
    for (let start = 0; start < channelData.length; start += CHUNK_FRAMES) {
      const frame = channelData.subarray(start, Math.min(start + CHUNK_FRAMES, channelData.length));
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: buffer.sampleRate,
        numberOfFrames: frame.length,
        numberOfChannels: 1,
        timestamp: timestampUs,
        data: frame,
      });
      encoder.encode(audioData);
      audioData.close();
      timestampUs += (frame.length / buffer.sampleRate) * 1_000_000;
    }

    await encoder.flush();
    encoder.close();
    if (encodeFailed) return null;

    muxer.finalize();
    return new Blob([target.buffer], { type: "audio/webm" });
  } catch {
    return null;
  }
}

export async function compressAudioForUpload(
  file: Blob,
  onProgress?: (message: string) => void,
): Promise<CompressAudioResult> {
  try {
    onProgress?.("오디오 최적화 중... (16kHz 모노로 변환)");
    const resampled = await decodeAndResample(file);

    onProgress?.("오디오 최적화 중... (경량 포맷으로 인코딩)");
    const opusBlob = await encodeOpusWebm(resampled);
    const candidate = opusBlob ?? encodeWav(resampled);
    const codec: CompressAudioCodec = opusBlob ? "opus" : "wav";

    if (candidate.size < file.size) {
      return { blob: candidate, mimeType: candidate.type, codec };
    }
    // Compression didn't actually help (tiny/already-compact source) —
    // never ship a bigger file than what the user gave us.
    return { blob: file, mimeType: file.type || "application/octet-stream", codec: "original" };
  } catch {
    return { blob: file, mimeType: file.type || "application/octet-stream", codec: "original" };
  }
}
