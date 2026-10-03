// Gemini-related strings shared by the server (lib/gemini.ts) and the client
// (components/RecordingDetailView.tsx, components/ReviewPanel.tsx). Kept free
// of @google/genai imports so client bundles can use it.

// Shown when Google rejects a request as PROHIBITED_CONTENT — a
// non-configurable, server-side block that SAFETY_SETTINGS can't lift. The
// server puts this exact sentence into the job's error message (optionally
// followed by where it happened), and the client matches on it to show a
// dedicated modal instead of the generic failure toast.
export const PROHIBITED_CONTENT_MESSAGE =
  "구글 AI 핵심 보안 정책에 의해 분석이 차단되었습니다. 강의 내용 중 AI가 허용하지 않는 극단적인 심리/임상 사례나 실제 " +
  "개인정보가 포함되어 있을 수 있습니다. 해당 구간을 잘라내거나 다른 파일로 시도해 주세요.";

// Splits a failure message into the policy-block notice and whatever detail
// the server appended after it (e.g. which audio chunk was blocked). Returns
// null for any other kind of failure.
export function parseProhibitedContentError(message: string): { detail: string } | null {
  const index = message.indexOf(PROHIBITED_CONTENT_MESSAGE);
  if (index === -1) return null;
  return { detail: message.slice(index + PROHIBITED_CONTENT_MESSAGE.length).trim() };
}
