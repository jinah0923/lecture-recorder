import { NextResponse } from "next/server";
import { ApiError, GoogleGenAI, Type, createPartFromBase64, createUserContent } from "@google/genai";
import type { Part } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gemini-3.6-flash";
const MAX_NOTE_LENGTH = 20_000;
const MAX_QUESTION_LENGTH = 500;
// Comfortably under Gemini's ~20MB total inline-request ceiling — this is a
// single attached photo (chemical structure, slide, handwriting), not a
// multi-file upload, so it's sent inline as base64 rather than through the
// Files API's upload/poll-for-ACTIVE dance used for audio/reference docs.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    anchorText: {
      type: Type.STRING,
      description:
        "기존 강의노트 원문에 실제로 존재하는 문장/제목의 일부를 정확히 그대로 인용 (이 심화 내용이 삽입될 위치 바로 앞부분)",
    },
    title: { type: Type.STRING, description: "이 블록이 강의노트에 추가/반영하는 내용을 요약하는 짧은 제목" },
    content: {
      type: Type.STRING,
      description:
        "기존 강의노트에 자연스럽게 이어붙일 완성형 마크다운 블록. 절대 '① 개념 정의 ② 심층 설명 ③ 실생활 예시' 같은 " +
        "고정 텍스트 템플릿을 강제하지 말 것 — 대신 기존 강의노트에서 이미 쓰인 마크다운 스타일(표, 불릿, 콜아웃, " +
        "헤딩 등)을 그대로 따라 작성. 사진/그림/구조식이 필요하면 마크다운 이미지(![설명](URL))를 적극 사용",
    },
  },
  required: ["anchorText", "title", "content"],
};

// Mirrors app/api/transcribe-and-summarize/route.ts's LATEX_BAN_RULE — this
// block gets merged into the very same lectureNote and rendered by the same
// three renderers (lib/markdown.tsx / lib/pdfExport.ts / export-to-notion),
// none of which parse LaTeX, so it must stay consistent with the main note.
const LATEX_BAN_RULE =
  "화살표나 기호를 작성할 때 절대 LaTeX 문법(예: \\rightarrow, $...$ 등 백슬래시 명령어나 달러 기호로 감싼 수식)을 " +
  "사용하지 마십시오. 반드시 일반 텍스트 기호(예: ->, =>, →, ≥, ≤, ±)만 사용하십시오.";

function fixEscapedNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

// Restricts server-side image fetches to this app's own image proxy route
// (app/api/deep-dive-image/route.ts — see lib/blobUpload.ts's
// buildDeepDiveImageProxyUrl for why the client wraps the URL that way)
// rather than letting this route fetch an arbitrary attacker-supplied URL on
// the server's behalf. That route independently re-validates its own `url`
// param against the actual Blob store's hostname before it will serve
// anything, so this only needs to confirm the request is headed there.
function isAllowedImageUrl(rawUrl: string, requestOrigin: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === requestOrigin && parsed.pathname === "/api/deep-dive-image" && parsed.searchParams.has("url");
  } catch {
    return false;
  }
}

// Downloads the learner's attached photo (already uploaded to Vercel Blob
// and wrapped in our own public proxy URL — see lib/blobUpload.ts) and
// inlines it as base64. Gemini has no way to dereference an arbitrary
// external URL itself, so the bytes have to be fetched and attached
// directly — the URL is passed separately in the text prompt below so the
// model can echo it back verbatim in its markdown output instead of
// inventing a new one.
async function fetchImageAsPart(url: string): Promise<Part> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`첨부한 이미지를 불러오지 못했습니다 (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("첨부한 이미지가 너무 큽니다.");
  }
  const base64 = Buffer.from(buffer).toString("base64");
  return createPartFromBase64(base64, contentType);
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

  let body: { lectureNote?: unknown; question?: unknown; imageUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const lectureNote = typeof body.lectureNote === "string" ? body.lectureNote.trim() : "";
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";

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
  if (imageUrl && !isAllowedImageUrl(imageUrl, new URL(request.url).origin)) {
    return NextResponse.json({ error: "유효하지 않은 이미지 URL입니다." }, { status: 400 });
  }

  let imagePart: Part | null = null;
  if (imageUrl) {
    try {
      imagePart = await fetchImageAsPart(imageUrl);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "첨부한 이미지를 처리하지 못했습니다." },
        { status: 502 },
      );
    }
  }

  const ai = new GoogleGenAI({ apiKey });

  const systemInstruction = [
    "당신은 단순 용어 사전이 아니라, 학습자의 요청에 맞춰 기존 강의노트를 보완·편집하는 '강의노트 보완/편집 엔진'입니다.",
    "반드시 지정된 JSON 스키마 형식으로만, 한국어로 응답하세요.",
    "먼저 학습자 질문의 의도를 파악하세요 — 예: 누락된 내용 추가, 기존 설명의 오류/부족한 부분 보완·수정, 특정 " +
      "양식(표/목록/단계별 정리 등)으로 변환 요청, 심화 개념 확장 요청 등. 그 의도에 정확히 맞는 내용을 작성하세요. " +
      "무관한 내용을 지어내지 말고, 정확하고 교육적인 내용만 작성하세요.",
    "anchorText는 아래 제공된 기존 강의노트 원문에 실제로 존재하는 문장이나 제목의 일부를 정확히 그대로(요약하거나 바꿔쓰지 말고) 인용해야 합니다. " +
      "이 블록이 삽입될 위치 바로 앞부분 — 즉 의미상 가장 자연스럽게 이어지는 지점을 고르세요.",
    "content는 절대로 '① 개념 정의 ② 심층 설명 ③ 실생활 예시' 같은 고정 텍스트 템플릿을 따르지 마세요. 대신 아래 " +
      "[기존 강의노트]를 먼저 관찰해 그 안에서 이미 쓰이고 있는 마크다운 스타일 — 제목 레벨, 불릿, 표, `> 🔥`/`> 🗣️`/ " +
      "`> 🚨 **[시험 출제 100%]**` 같은 콜아웃 표기, 굵게 표시 등 — 을 그대로 따라, 마치 원래 강의노트 작성자가 처음부터 " +
      "그 자리에 써넣은 것처럼 자연스럽게 이어지는 완성형 블록을 작성하세요. 요청이 '표로 정리해줘'라면 표로, " +
      "'누락된 내용을 추가해줘'라면 그 자리에 원래 있었어야 할 문단처럼, '이 설명을 수정/보완해줘'라면 정정되거나 " +
      "보강된 설명 자체를 본문 톤 그대로 작성하세요 — 어떤 경우에도 별도 템플릿으로 도배하지 마세요.",
    "사용자가 '사진', '그림', '구조식', '이미지' 등 시각 자료를 명시적으로 요청한 경우에는 실제로 존재한다고 확신할 수 " +
      "있는 신뢰할 만한 외부 이미지 URL(예: Wikipedia/Wikimedia Commons처럼 안정적인 직접 이미지 파일 URL)을 마크다운 " +
      "이미지 문법 `![설명](https://실제-이미지-URL)`으로 본문에 적극 삽입하세요. 확신할 수 없는 URL을 지어내지는 말고, " +
      "그런 경우 어떤 자료를 찾아보면 좋을지 텍스트로 안내하세요.",
    imagePart
      ? "학습자가 이미지(사진)를 직접 첨부했습니다. 이 이미지의 내용(화학 구조식, 슬라이드 도표, 손글씨 메모 등)을 " +
        "자세히 분석해서 학습자의 질문에 답하는 설명을 작성하세요. 아래 [학습자가 첨부한 이미지]에 제공된 정확한 " +
        "URL을 content 안에서 정확히 그대로 사용해 마크다운 이미지 문법 `![설명](그 URL)`으로 본문 적절한 위치에 " +
        "삽입하세요 — 이 URL을 절대 변형하거나 다른 URL로 대체하지 마세요."
      : "",
    "비교·분류가 필요한 내용은 마크다운 표(`| ... | ... |` 문법)로 정리하세요.",
    "[원본 보존 — 절대 규칙] 당신은 [기존 강의노트]의 마크다운 원문을 단 한 글자도 지우거나, 바꿔 쓰거나, 다른 " +
      "내용으로 대체(Replace)할 수 없습니다. 사용자가 특정 문장이나 구간을 콕 집어 '이 부분을 수정해줘', '이 설명을 " +
      "고쳐줘'처럼 요청하더라도, 그 원문 문장 자체를 content에 다시 옮겨 적거나 바꿔 쓰지 마세요 — 오직 그 문장 " +
      "바로 뒤에 자연스럽게 덧붙는 보충·정정 설명만 새로 작성하세요 (예: '위 설명에 덧붙이면, ...' 처럼 원문은 그대로 " +
      "둔 채 추가되는 문단/콜아웃으로). content는 anchorText 위치 바로 다음 줄에 항상 새로 삽입(Append)되는 " +
      "블록이며, 절대로 기존 문장을 삭제하거나 덮어쓰는 용도로 쓰이지 않습니다 — 이 사실을 항상 염두에 두고 " +
      "작성하세요.",
    LATEX_BAN_RULE,
  ]
    .filter(Boolean)
    .join(" ");

  const userPrompt = [
    "[기존 강의노트]",
    lectureNote,
    "",
    "[학습자의 요청]",
    question,
    "",
    ...(imagePart
      ? [
          "[학습자가 첨부한 이미지]",
          "이 이미지의 실제 URL: " + imageUrl,
          "(이 이미지는 이 텍스트 프롬프트 바로 다음에 별도 파일로 함께 첨부되어 있습니다. 이미지 내용을 분석해 " +
            "설명에 반영하고, content 안에서 이 이미지를 가리킬 때는 반드시 위 URL을 정확히 그대로 사용하세요.)",
          "",
        ]
      : []),
    "위 요청의 의도(누락 내용 추가 / 기존 설명 보완·수정 / 특정 양식으로 변환 / 심화 개념 확장 등)를 먼저 파악한 뒤, " +
      "아래 항목을 작성해주세요.",
    "1. content: 요청 의도에 맞는 완성형 마크다운 블록을 작성하세요. '① 개념 정의 ② 심층 설명 ③ 실생활 예시' 같은 " +
      "고정 템플릿은 절대 사용하지 말고, 위 [기존 강의노트]에서 이미 쓰이고 있는 마크다운 스타일(표/불릿/콜아웃/헤딩 " +
      "등)을 그대로 따라, 원래 강의노트의 일부였던 것처럼 자연스럽게 작성하세요. 사진/그림/구조식이 필요하면 신뢰할 " +
      "수 있는 이미지 URL을 마크다운 이미지로 첨부하고, 비교표가 필요하면 마크다운 표를 사용하세요. [원본 보존] " +
      "content에는 [기존 강의노트]의 원문 문장을 그대로 옮겨 적지 마세요 — 이 블록은 anchorText 바로 뒤에 " +
      "추가(Append)될 새 내용일 뿐, 원문을 대체하는 용도가 아닙니다.",
    "2. title: 이 블록이 강의노트에 추가/반영하는 내용을 요약하는 짧은 제목을 지어주세요.",
    "3. anchorText: 위 [기존 강의노트] 원문 안에서, 이 내용이 삽입되기 가장 적합한 위치 바로 앞의 문장이나 제목을 원문 그대로 정확히 인용하세요.",
  ].join("\n");

  console.log("[expand-note] calling Gemini", {
    model: MODEL,
    lectureNoteChars: lectureNote.length,
    questionChars: question.length,
    hasImage: imagePart !== null,
  });

  let responseText: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: imagePart ? createUserContent([userPrompt, imagePart]) : userPrompt,
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
