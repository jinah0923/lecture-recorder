import { NextResponse } from "next/server";
import { ApiError, GoogleGenAI, Type } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gemini-3.6-flash";
const MAX_NOTE_LENGTH = 20_000;
const MAX_QUESTION_LENGTH = 500;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    anchorText: {
      type: Type.STRING,
      description:
        "기존 강의노트 원문에 실제로 존재하는 문장/제목의 일부를 정확히 그대로 인용 (이 심화 내용이 삽입될 위치 바로 앞부분)",
    },
    title: { type: Type.STRING, description: "심화 탐구 블록의 짧은 제목" },
    content: {
      type: Type.STRING,
      description:
        "심화 탐구 본문 (마크다운). 기본은 '① 개념 정의 ② 심층 설명 ③ 실생활 예시' 구조이지만 강제 규칙은 아니며, " +
        "사진/그림/구조식이 필요하면 그 구조에 얽매이지 말고 마크다운 이미지(![설명](URL))를 적극 사용",
    },
  },
  required: ["anchorText", "title", "content"],
};

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
  const message = error instanceof Error ? error.message : "AI 심화 탐구에 실패했습니다.";
  return `Gemini 요청 실패: ${message}`;
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다. .env.local을 확인해주세요." },
      { status: 500 },
    );
  }

  let body: { lectureNote?: unknown; question?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const lectureNote = typeof body.lectureNote === "string" ? body.lectureNote.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!lectureNote) {
    return NextResponse.json(
      { error: "기존 강의노트가 비어 있습니다. 먼저 AI 분석을 완료해주세요." },
      { status: 400 },
    );
  }
  if (!question) {
    return NextResponse.json({ error: "궁금한 내용을 입력해주세요." }, { status: 400 });
  }
  if (lectureNote.length > MAX_NOTE_LENGTH) {
    return NextResponse.json({ error: "강의노트가 너무 깁니다." }, { status: 413 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json(
      { error: `질문은 ${MAX_QUESTION_LENGTH}자 이내로 입력해주세요.` },
      { status: 400 },
    );
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemInstruction = [
    "당신은 기존 강의노트를 바탕으로 학습자의 추가 질문에 대해 심화 학습 콘텐츠를 만드는 어시스턴트입니다.",
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    "질문과 무관한 내용을 지어내지 말고, 정확하고 교육적인 내용을 작성하세요.",
    "anchorText는 아래 제공된 기존 강의노트 원문에 실제로 존재하는 문장이나 제목의 일부를 정확히 그대로(요약하거나 바꿔쓰지 말고) 인용해야 합니다.",
    "content는 마크다운 형식의 본문입니다. 기본적으로 '① 개념 정의', '② 심층 설명', '③ 실생활 예시' 세 부분으로 구성하되, " +
      "이 3단 구조는 강제 규칙이 아니라 기본 골격일 뿐입니다.",
    "사용자가 '사진', '그림', '구조식', '이미지', '표' 등 시각 자료를 명시적으로 요청한 경우에는 절대로 3단 텍스트 형식에 " +
      "억지로 끼워맞추지 마세요. 대신 실제로 존재한다고 확신할 수 있는 신뢰할 만한 외부 이미지 URL(예: Wikipedia/Wikimedia " +
      "Commons처럼 안정적인 직접 이미지 파일 URL)을 마크다운 이미지 문법 `![설명](https://실제-이미지-URL)`으로 본문에 적극 " +
      "삽입하세요. 확신할 수 없는 URL을 지어내지는 말고, 그런 경우 어떤 자료를 찾아보면 좋을지 텍스트로 안내하세요.",
    "비교·분류가 필요한 내용은 마크다운 표(`| ... | ... |` 문법)로 정리하세요.",
  ].join(" ");

  const userPrompt = [
    "[기존 강의노트]",
    lectureNote,
    "",
    "[학습자의 추가 질문/키워드]",
    question,
    "",
    "위 질문에 대해 아래 항목을 작성해주세요.",
    "1. content: 심화 탐구 본문을 마크다운으로 작성하세요. 기본은 ①개념 정의 ②심층 설명 ③실생활 예시 구조를 따르되, " +
      "사진/그림/구조식 등 시각 자료가 필요한 질문이면 이 구조에 얽매이지 말고 신뢰할 수 있는 이미지 URL을 마크다운 " +
      "이미지로 적극 첨부하고, 비교표가 필요하면 마크다운 표를 사용하세요.",
    "2. title: 이 심화 탐구 블록의 짧은 제목을 지어주세요.",
    "3. anchorText: 위 [기존 강의노트] 원문 안에서, 이 심화 내용이 삽입되기 가장 적합한 위치 바로 앞의 문장이나 제목을 원문 그대로 정확히 인용하세요.",
  ].join("\n");

  console.log("[expand-note] calling Gemini", {
    model: MODEL,
    lectureNoteChars: lectureNote.length,
    questionChars: question.length,
  });

  let responseText: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "안전 정책으로 인해 이 요청을 처리할 수 없습니다." },
        { status: 502 },
      );
    }

    responseText = response.text;
  } catch (error) {
    console.error("[expand-note] Gemini call failed", {
      model: MODEL,
      status: error instanceof ApiError ? error.status : undefined,
      error,
    });
    return NextResponse.json({ error: describeGeminiError(error) }, { status: 502 });
  }

  if (!responseText) {
    return NextResponse.json({ error: "AI로부터 응답을 받지 못했습니다. 다시 시도해주세요." }, { status: 502 });
  }

  let parsed: {
    anchorText?: unknown;
    title?: unknown;
    content?: unknown;
  };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return NextResponse.json({ error: "AI 응답을 해석하는 데 실패했습니다. 다시 시도해주세요." }, { status: 502 });
  }

  return NextResponse.json({
    anchorText: typeof parsed.anchorText === "string" ? fixEscapedNewlines(parsed.anchorText.trim()) : "",
    title: typeof parsed.title === "string" ? fixEscapedNewlines(parsed.title.trim()) : question,
    content: typeof parsed.content === "string" ? fixEscapedNewlines(parsed.content.trim()) : "",
  });
}
