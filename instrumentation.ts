// Runs once when the Next.js server starts (dev terminal, `next start`,
// Vercel function logs). Only used to say up front that the optional OpenAI
// analysis engine is unavailable — without the key, a failed Gemini analysis
// simply won't offer the "re-analyze with OpenAI" button.
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.OPENAI_API_KEY?.trim()) return;
  console.warn(
    [
      "",
      "[lecture-recorder] OPENAI_API_KEY가 설정되어 있지 않습니다 — Gemini 분석 실패 시 'OpenAI로 다시 분석' 버튼이 표시되지 않습니다.",
      "  사용하려면 .env.local에 다음 줄을 추가하고 서버를 다시 시작하세요:",
      "    OPENAI_API_KEY=sk-...",
      "  Vercel 배포본은 Project Settings → Environment Variables에 같은 이름으로 추가한 뒤 재배포하세요.",
      "",
    ].join("\n"),
  );
}
