// "[자료 누락]" — a note analyzed from the recording alone (no textbook /
// slides attached, or "자료 없이 스크립트만 재분석") says so in its first line,
// so a missing attachment doesn't go unnoticed. This is a different case from
// the "'[자료 생략]' 금지" rule, which stops the model from skipping material
// that WAS attached.
//
// The prompt asks for it (MISSING_MATERIAL_RULE, only when nothing is
// attached) and ensureMissingMaterialNotice puts it there if the model
// didn't — both engines call it with the attachment count they actually had.

export const MISSING_MATERIAL_NOTICE =
  "> ⚠️ **[자료 누락]** 첨부된 교재가 없어 음성 스크립트만으로 분석되었습니다. 정확한 수식이나 도표가 누락될 수 있으니 " +
  "'자료 추가해서 다시 분석'을 권장합니다.";

export const MISSING_MATERIAL_RULE =
  "[자료 누락 경고 — 교재·교안이 첨부되지 않은 이번 분석에서는 필수] 이번 요청에는 교재·교안·슬라이드가 첨부되지 않았습니다. " +
  "lectureNote의 맨 첫 줄(`> 🔥` 핵심 단서 콜아웃이나 전체 개요 마인드맵보다도 앞)에 아래 경고 콜아웃을 정확히 이 문구 그대로 " +
  "한 줄로 쓰고, 그 다음 줄은 비워 두세요:\n" +
  `${MISSING_MATERIAL_NOTICE}\n` +
  "(이 경고는 자료가 아예 없다는 사실을 알리는 것입니다. 자료가 첨부된 경우의 '[자료 생략]' 표기 금지 규칙과는 별개이며, 본문 " +
  "중간에 '[자료 생략]' 같은 표기를 쓰라는 뜻이 아닙니다.)";

export function ensureMissingMaterialNotice(note: string): string {
  if (note.includes("[자료 누락]")) return note;
  return note.trim() ? `${MISSING_MATERIAL_NOTICE}\n\n${note}` : note;
}
