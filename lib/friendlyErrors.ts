// Turning HTTP failures into messages a student can act on. Used on the
// server when describing an AI provider's error (lib/gemini.ts,
// lib/openai.ts) and on the client for whatever still arrives raw — a
// Vercel 413 before our route even runs, a Vercel Blob upload error, a
// dropped connection — before it reaches a toast.
//
// The status code is kept as a short "(오류 코드 402)" tail: not the cause
// itself, but what to quote when asking for help.

export const CREDIT_EXHAUSTED_MESSAGE =
  "API 호출 한도(크레딧)를 초과했습니다. API 플랫폼의 결제(Billing) 대시보드를 확인해 주세요.";
const RATE_LIMITED_MESSAGE = "짧은 시간에 요청이 너무 많아 잠시 제한되었습니다. 1~2분 뒤에 다시 시도해 주세요.";
// A 429 that doesn't say whether it's a per-minute limit or a spent quota.
const LIMIT_UNCLEAR_MESSAGE =
  "API 사용 한도에 도달했습니다. 1~2분 뒤에 다시 시도해 보고, 계속 실패하면 API 플랫폼의 결제(Billing)·할당량 대시보드를 확인해 주세요.";
const PAYLOAD_TOO_LARGE_MESSAGE =
  "파일 용량이 너무 커서 처리할 수 없습니다. 파일을 나누거나 용량을 줄여(PDF 압축, 이미지 해상도 낮추기 등) 다시 시도해 주세요.";
const SERVER_BUSY_MESSAGE = "AI 서버가 일시적으로 혼잡하거나 응답하지 않습니다. 잠시 뒤에 다시 시도해 주세요.";
const TIMEOUT_MESSAGE = "응답을 기다리다 시간이 초과되었습니다. 잠시 뒤에 다시 시도해 주세요.";
const NETWORK_MESSAGE = "네트워크 연결이 끊겨 요청을 보내지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.";
const STORAGE_SUSPENDED_MESSAGE =
  "파일 저장소(Vercel Blob) 사용 한도를 초과해 업로드가 막혔습니다. Vercel 대시보드의 사용량·결제(Billing)를 확인해 주세요.";

const FRIENDLY_MESSAGES = [
  CREDIT_EXHAUSTED_MESSAGE,
  RATE_LIMITED_MESSAGE,
  LIMIT_UNCLEAR_MESSAGE,
  PAYLOAD_TOO_LARGE_MESSAGE,
  SERVER_BUSY_MESSAGE,
  TIMEOUT_MESSAGE,
  NETWORK_MESSAGE,
  STORAGE_SUSPENDED_MESSAGE,
];

// What a provider's 429 / error text says about the cause.
const CREDIT_PATTERN =
  /insufficient[_ ]quota|billing|credit|prepay|payment required|balance|잔액|결제|per ?day|daily|check your plan/i;
const PER_MINUTE_PATTERN = /per ?minute|retry in|try again in|rate[_ ]?limit|requests per/i;

function withCode(message: string, status: number): string {
  return `${message} (오류 코드 ${status})`;
}

// A status the user should hear about in plain words, or null when the
// caller's own provider-specific message is better (401/403/404 …).
// `detail` is the provider's raw text, used only to tell what a 429 means.
export function friendlyHttpMessage(status: number, detail = ""): string | null {
  if (status === 402) return withCode(CREDIT_EXHAUSTED_MESSAGE, status);
  if (status === 413) return withCode(PAYLOAD_TOO_LARGE_MESSAGE, status);
  if (status === 429) {
    if (PER_MINUTE_PATTERN.test(detail) && !/per ?day|daily|prepay|credit/i.test(detail)) {
      return withCode(RATE_LIMITED_MESSAGE, status);
    }
    if (CREDIT_PATTERN.test(detail)) return withCode(CREDIT_EXHAUSTED_MESSAGE, status);
    return withCode(LIMIT_UNCLEAR_MESSAGE, status);
  }
  if (status === 408 || status === 504) return withCode(TIMEOUT_MESSAGE, status);
  if (status === 502 || status === 503) return withCode(SERVER_BUSY_MESSAGE, status);
  return null;
}

// A raw error message that reached the client, translated when it carries a
// recognizable status or cause; anything else (our own Korean messages)
// comes back unchanged.
export function toFriendlyErrorMessage(message: string): string {
  if (FRIENDLY_MESSAGES.some((friendly) => message.includes(friendly))) return message;

  if (/suspended/i.test(message) && /blob|store/i.test(message)) return STORAGE_SUSPENDED_MESSAGE;
  if (/payment required/i.test(message)) return friendlyHttpMessage(402, message)!;
  if (/payload too large|request entity too large|FUNCTION_PAYLOAD_TOO_LARGE|file ?size exceeds|too large/i.test(message)) {
    return friendlyHttpMessage(413, message)!;
  }
  if (/too many requests|RESOURCE_EXHAUSTED|insufficient[_ ]quota/i.test(message)) return friendlyHttpMessage(429, message)!;

  // An explicit status code: "HTTP 402", "status 413", "(429)", "code: 503".
  const status = Number(message.match(/(?:HTTP|status(?: code)?|code)[\s:=]*([45]\d\d)\b|\(([45]\d\d)\)/i)?.slice(1).find(Boolean));
  if (status) {
    const friendly = friendlyHttpMessage(status, message);
    if (friendly) return friendly;
  }

  if (/failed to fetch|networkerror|network error|load failed|network request failed/i.test(message)) return NETWORK_MESSAGE;
  if (/timed? ?out|timeout/i.test(message) && !/[가-힣]/.test(message)) return TIMEOUT_MESSAGE;
  return message;
}
