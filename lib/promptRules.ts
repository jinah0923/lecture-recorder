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

// Formulas used to come out split across lines or bullets with half-bolded
// terms ("**자산** = 부채 +" / "* 자본**"), leaving unclosed ** that broke the
// rendering. One canonical form instead: each formula on its own unbroken
// "> 🧮 " line, which every renderer shows as a standalone formula block
// (lib/noteBlocks.ts). Shared with the deep-dive writer, whose blocks merge
// into the same note.
export const EQUATION_FORMAT_RULE = [
  "[수식·등식 전용 블록 — 마크다운 깨짐 방지, 최우선 서식 규칙] 회계 등식, 공식, 계산식처럼 =, +, −, ×, ÷ 등으로 이어지는 " +
    "수식/등식(예: 자산 = 부채 + 자본)은 본문 문장이나 글머리 기호 안에 섞어 쓰지 말고, 앞뒤를 빈 줄로 띄운 독립된 한 줄 맨 " +
    "앞에 `> 🧮 `를 붙여 작성하세요. 예:\n\n> 🧮 자산 = 부채 + 자본\n",
  "- 하나의 수식은 반드시 끊기지 않는 한 줄로 쓰세요. 수식 중간에서 줄을 바꾸거나, 수식의 항을 글머리 기호(-, *)로 " +
    "쪼개 여러 줄에 나눠 쓰는 것은 금지입니다.",
  "- 수식 줄 안에서는 `**` 볼드를 쓰지 마세요 — 수식 블록은 화면에서 이미 굵게 강조되어 표시됩니다. 특정 단어만 볼드로 " +
    "감싸려다 `**`의 짝이 맞지 않게 되는 것이 서식이 깨지는 주된 원인입니다.",
  "- 교수가 강조한 수식이라면 수식 전체를 `<mark>`로 감쌀 수 있습니다: `> 🧮 <mark>자산 = 부채 + 자본</mark>`.",
  "- 여러 단계로 전개되는 식은 단계마다 `> 🧮 ` 줄을 하나씩 연달아 쓰세요. 수식의 의미·각 항의 설명은 수식 줄 바로 " +
    "아래에 별도의 문장이나 글머리 기호로 쓰세요(설명을 수식 줄 안에 붙이지 말 것).",
  "- 수식 기호는 LaTeX가 아닌 일반 텍스트 기호(=, +, −, ×, ÷, →)만 사용하세요.",
].join("\n");
