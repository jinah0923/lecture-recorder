// Which kind of request a note-expansion question is (app/api/expand-note).
//
// "restore" — something is missing from the note ("A 내용이 빠졌어"). The
//   answer may only come from the recording's transcript and the attached
//   material (strict grounding); the model must not fill gaps from its own
//   knowledge.
// "deepDive" — the learner explicitly asked for more depth ("더 자세히 알려줘",
//   "심화해서 설명해줘"). Only then may outside knowledge be used, and it is
//   labelled as such in the block.
//
// Decided by plain keyword rules rather than by the model, so the stricter
// mode can't be talked out of: a request that mentions something missing is
// always "restore", even if it also says "자세히", and anything that names
// neither is "restore" too.
export type ExpandMode = "restore" | "deepDive";

const MISSING_PATTERN = /빠졌|빠진|빠져|빠뜨|누락|빼먹|안\s*들어|안\s*적|없어|없네|없음|복원|채워/;
const DEEP_DIVE_PATTERN = /자세히|자세하게|상세히|상세하게|심화|심층|깊이|깊게|더\s*알려|더\s*설명|확장해|배경\s*지식|원리/;

// null = the text doesn't say either way (e.g. "표로 정리해 줘").
export function detectExpandMode(text: string): ExpandMode | null {
  if (MISSING_PATTERN.test(text)) return "restore";
  if (DEEP_DIVE_PATTERN.test(text)) return "deepDive";
  return null;
}

export function isExpandMode(value: unknown): value is ExpandMode {
  return value === "restore" || value === "deepDive";
}

// A follow-up instruction on an existing block keeps that block's mode
// unless the instruction itself asks for the other one.
export function resolveExpandMode(question: string, instruction?: string, previousMode?: ExpandMode): ExpandMode {
  return (
    (instruction ? detectExpandMode(instruction) : null) ??
    previousMode ??
    detectExpandMode(question) ??
    "restore"
  );
}

export const EXPAND_MODE_LABELS: Record<ExpandMode, string> = {
  restore: "📄 누락 내용 복원 · 녹음/교재 기반",
  deepDive: "📚 심화 탐구 · 외부 지식 포함",
};
