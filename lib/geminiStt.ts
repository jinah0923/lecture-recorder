// Gemini speech-to-text for one audio file — shared by the full analysis job
// (app/api/transcribe-and-summarize, short recordings) and the per-piece
// endpoint the browser calls one piece at a time for long recordings
// (app/api/transcribe-chunk), so each piece gets its own 300s budget.

import { Type, createPartFromUri, createUserContent } from "@google/genai";
import type { File as GenAiFile, GoogleGenAI } from "@google/genai";
import { ACADEMIC_CONTEXT_INSTRUCTION, GEMINI_MAX_OUTPUT_TOKENS, SAFETY_SETTINGS, readResponseText } from "@/lib/gemini";
import { MODEL } from "@/lib/geminiAnalysis";
import { TIME_LIMIT_MESSAGE, hardStopSignal } from "@/lib/jobDeadline";

// Split into two independent schemas/calls (see callSttWorker/callAnalysisWorker
// below) instead of one combined response — a single call sharing one
// maxOutputTokens budget across a 30min+ verbatim transcript AND a deep,
// textbook-length lecture note reliably ran out of budget mid-transcript.
// Separating them gives each its own full token budget.
export const STT_RESPONSE_SCHEMA = {
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

export type RawSttResponse = { hasSpeech?: unknown; script?: unknown };

// Worker A — STT only. Its entire maxOutputTokens budget goes toward the
// verbatim transcript alone, so a long lecture no longer competes with the
// lecture note for the same token ceiling. Plain (non-streaming) calls now
// that nothing is listening for incremental chunks — the background job has
// no connection to keep alive, unlike the SSE-streaming version this route
// used before moving to the job-queue architecture (see the file-level
// comment above).
// A transcript is what was said, in words — no formula markup even though
// the note itself may use LaTeX (MATH_NOTATION_RULE in lib/promptRules.ts).
const TRANSCRIPT_PLAIN_TEXT_RULE =
  "받아쓰기 텍스트에는 LaTeX 문법(예: \\rightarrow, $...$ 등 백슬래시 명령어나 달러 기호로 감싼 수식)을 절대 쓰지 마세요. " +
  "수식이나 기호를 말한 부분도 들린 그대로 일반 텍스트(필요하면 →, ≥, ≤, ± 같은 일반 기호)로 적으세요.";

export async function callSttWorker(ai: GoogleGenAI, uploadedAudio: GenAiFile): Promise<RawSttResponse> {
  const systemInstruction = [
    ACADEMIC_CONTEXT_INSTRUCTION,
    "당신은 강의 녹음 오디오를 한 글자도 빠짐없이 받아쓰는 음성 인식(STT) 전문 어시스턴트입니다.",
    "반드시 지정된 JSON 스키마 형식으로만 응답하세요. 들린 언어 그대로 받아쓰세요 — 한국어 발화는 한국어로, 교수가 영어로 " +
      "발음한 단어·전문 용어(예: myoblast)는 번역하거나 한글로 음차하지 말고 영문 철자 그대로 적으세요. 들린 단어를 약어·기호·" +
      "동의어로 바꾸지도 마세요 — 교수가 'deoxyribonucleic acid'라고 말했다면 'DNA'로 줄이지 말고, 'DNA'라고 말했다면 풀어 " +
      "쓰지 마세요. 발음된 단어 그대로가 정답입니다.",
    "당신의 유일한 임무는 오디오에 실제로 발화된 내용을 정확하게 받아쓰는 것입니다 — 요약하거나 압축하거나 의역하지 마세요.",
    "script는 반드시 오디오 00:00부터 끝까지에 대한 100% 완전한 받아쓰기여야 합니다. 오디오가 길다는 이유로 " +
      "일부 구간을 생략, 압축, 요약하는 것은 절대 허용되지 않습니다.",
    TRANSCRIPT_PLAIN_TEXT_RULE,
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

  // A transcript cut off halfway is no use as a timestamped script, so a call
  // still running near the platform's 300s kill is stopped (hardStopSignal)
  // and reported as such — instead of the job vanishing with no message.
  const stopSignal = hardStopSignal();
  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([
        userPrompt,
        createPartFromUri(uploadedAudio.uri ?? "", uploadedAudio.mimeType ?? "audio/webm"),
      ]),
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: STT_RESPONSE_SCHEMA,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        safetySettings: SAFETY_SETTINGS,
        ...(stopSignal ? { abortSignal: stopSignal } : {}),
      },
    });
  } catch (error) {
    if (stopSignal?.aborted) throw new Error(TIME_LIMIT_MESSAGE);
    throw error;
  }

  const text = readResponseText(response, "스크립트(STT)");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("스크립트 응답을 해석하는 데 실패했습니다. 다시 시도해주세요.");
  }
}
