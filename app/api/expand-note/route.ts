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
    definition: { type: Type.STRING, description: "① 개념 정의" },
    deepDive: { type: Type.STRING, description: "② 확장 심층 설명" },
    example: { type: Type.STRING, description: "③ 쉬운 실생활 예시" },
  },
  required: ["anchorText", "title", "definition", "deepDive", "example"],
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
  ].join(" ");

  const userPrompt = [
    "[기존 강의노트]",
    lectureNote,
    "",
    "[학습자의 추가 질문/키워드]",
    question,
    "",
    "위 질문에 대해 아래 항목을 작성해주세요.",
    "1. definition: 개념을 명확하고 간결하게 정의하세요.",
    "2. deepDive: 배경, 원리, 관련 개념과의 관계 등을 포함한 확장된 심층 설명을 작성하세요.",
    "3. example: 이해를 돕는 쉽고 구체적인 실생활 예시를 들어주세요.",
    "4. title: 이 심화 탐구 블록의 짧은 제목을 지어주세요.",
    "5. anchorText: 위 [기존 강의노트] 원문 안에서, 이 심화 내용이 삽입되기 가장 적합한 위치 바로 앞의 문장이나 제목을 원문 그대로 정확히 인용하세요.",
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
    definition?: unknown;
    deepDive?: unknown;
    example?: unknown;
  };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return NextResponse.json({ error: "AI 응답을 해석하는 데 실패했습니다. 다시 시도해주세요." }, { status: 502 });
  }

  return NextResponse.json({
    anchorText: typeof parsed.anchorText === "string" ? fixEscapedNewlines(parsed.anchorText.trim()) : "",
    title: typeof parsed.title === "string" ? fixEscapedNewlines(parsed.title.trim()) : question,
    definition: typeof parsed.definition === "string" ? fixEscapedNewlines(parsed.definition.trim()) : "",
    deepDive: typeof parsed.deepDive === "string" ? fixEscapedNewlines(parsed.deepDive.trim()) : "",
    example: typeof parsed.example === "string" ? fixEscapedNewlines(parsed.example.trim()) : "",
  });
}
