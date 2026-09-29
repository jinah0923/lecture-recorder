// Prompt rules shared by every Gemini call that writes into the lecture note
// (app/api/transcribe-and-summarize/route.ts's analysis worker and
// app/api/expand-note/route.ts), so the note body and deep-dive blocks can't
// drift into different terminology conventions.

// Without this, the model kept the professor's English term only once, in
// parentheses behind its own Korean rendering ("마이오블라스트(Myoblast)",
// "융합(Fusion)"), then dropped the English entirely in later sentences and
// occasionally generalized it away ("근육 세포").
export const VERBATIM_TERMINOLOGY_RULE = [
  "[원본 워딩 최우선 보존(Verbatim Terminology) — 최우선 규칙] 교수가 실제로 말한(또는 강의자료에 적힌) 명사·전문 용어·영어 단어" +
    "(특히 생물·화학 등 전공 학술 용어)는 교수가 쓴 그 형태 그대로 적으세요. 이 규칙은 제목, 본문, 불릿, 마크다운 표(항목명·" +
    "키워드 칸 포함), 콜아웃, 요약, 체크리스트 등 출력의 모든 위치에, 첫 등장뿐 아니라 등장할 때마다 적용됩니다.",
  "- 교수가 영어로 발음한 용어(예: myoblast, satellite cell, quiescent)는 영문 철자를 메인 키워드로 쓰세요. 한글 번역어나 한글 " +
    "음차를 메인으로 쓰고 영어를 괄호로 밀어내지 마세요. 뜻 설명이 필요하면 영어 뒤 괄호에 병기하세요. " +
    "올바른 예: 'myoblast(근육모세포)', 'quiescent(휴지기) 상태'. 잘못된 예: '근아세포(myoblast)', '마이오블라스트(Myoblast)', " +
    "'위성세포(Satellite cell)', '융합(fusion)'.",
  "- 괄호 병기는 처음 등장할 때 한 번이면 충분합니다. 그 뒤 문장에서도 영문 용어 자체를 그대로 반복해 쓰세요 — 두 번째 " +
    "등장부터 번역어나 음차로 바꿔 쓰는 것도 금지입니다.",
  "- 교수가 한국어로 말한 용어는 그 한국어 그대로 쓰세요. 당신이 영어나 다른 한국어 동의어로 바꾸지 마세요.",
  "- 더 쉽거나 흔한 유의어, 상위 개념, 일반 명사로 뭉뚱그리는 것은 금지입니다 (예: 교수가 'myoblast'라고 했다면 " +
    "'Muscle cells'나 '근육 세포'로 쓰지 말고 'myoblast'로 쓰세요).",
  "- 어휘가 충돌하면 당신이 사전 학습한 어휘·표기 관행보다 녹음(스크립트)과 강의자료에 나온 어휘(Lexicon)를 무조건 따르세요.",
  "- 예외: STT가 명백히 잘못 알아들은 오인식(발음이 비슷한 엉뚱한 단어)을 키워드 목록이나 강의자료를 근거로 교수가 의도한 " +
    "원래 용어로 바로잡는 것은 허용됩니다 — 이것은 교정이지 유의어 대체가 아닙니다.",
].join("\n");
