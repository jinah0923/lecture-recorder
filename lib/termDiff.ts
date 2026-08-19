export type TermChange = { oldTerm: string; newTerm: string };

// Single Korean syllables / very short tokens are almost always particles or
// connectors (이, 가, 그, 및 …) — treating them as "changed terms" would
// trigger a global find-and-replace that corrupts unrelated text throughout
// the note. Require a minimum length before a diff is trusted as a real term.
const MIN_TERM_LENGTH = 2;
// If a segment edit produces more differing runs than this, it reads as a
// broader rewrite rather than a targeted correction — skip auto-sync rather
// than risk applying several risky global replacements at once.
const MAX_TERM_CHANGES = 3;

const PUNCTUATION_RE = /[.,!?~…"'“”‘’()[\]{}·:;]/g;

// Korean particles attach directly to a word with no space ("방송대는",
// "방송대에서", "방송대를", …), so a naive whitespace-tokenized diff on
// "방송대는" → "방통대는" extracts "방송대는" → "방통대는" as the changed
// term. That literal string then fails to match the same root word
// elsewhere in the summary/notes if it's inflected with a *different*
// particle there (e.g. "방송대의") — replaceAll silently finds nothing and
// the sync looks like it did nothing. Stripping a trailing particle before
// comparing/extracting isolates the actual root word ("방송대" → "방통대"),
// which then matches regardless of what particle (if any) is attached
// elsewhere. Ordered longest-first so e.g. "에서" strips before "에".
const TRAILING_PARTICLES = [
  "으로부터", "에서부터", "이야말로", "이라고는", "이라고도",
  "한테서", "에게서", "이었다", "이라도", "이라야", "이나마",
  "으로써", "으로서", "으로는", "으로도", "이라고", "라고도",
  "이지만", "이라는", "야말로", "라고", "로부터", "로써", "로서",
  "로는", "로도", "부터", "까지", "마저", "조차", "밖에", "한테",
  "에게", "께서", "에서", "지만", "이며", "이랑", "이지", "이고",
  "이든", "라도", "라야", "나마", "만큼", "처럼", "보다", "라는",
  "와는", "과는", "와도", "과도", "으로", "로", "께", "와", "과",
  "이나", "이야", "랑", "며", "고", "든", "지", "만", "도",
  "은", "는", "이", "가", "을", "를", "의",
].sort((a, b) => b.length - a.length);

function stripTrailingParticle(word: string): string {
  for (const particle of TRAILING_PARTICLES) {
    if (word.length > particle.length && word.endsWith(particle)) {
      return word.slice(0, -particle.length);
    }
  }
  return word;
}

function normalizeWord(word: string): string {
  return stripTrailingParticle(word.replace(PUNCTUATION_RE, ""));
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

// Longest common subsequence over normalized tokens — returns the indices
// (into the ORIGINAL token arrays) of tokens that match on both sides, in
// order. Everything between two matches (or before the first / after the
// last) is a run that differs between oldText and newText.
function lcsIndices(oldNorm: string[], newNorm: string[]): Array<[number, number]> {
  const n = oldNorm.length;
  const m = newNorm.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldNorm[i] === newNorm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldNorm[i] === newNorm[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Diffs a transcript segment's before/after text at word level and returns
 * only genuine term substitutions — e.g. "김진화" → "김진아". Whitespace-only
 * or punctuation-only edits (and edits that look like a full rewrite rather
 * than a targeted fix) resolve to an empty array.
 */
export function extractChangedTerms(oldText: string, newText: string): TermChange[] {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  if (oldTokens.length === 0 || newTokens.length === 0) return [];

  const oldNorm = oldTokens.map(normalizeWord);
  const newNorm = newTokens.map(normalizeWord);

  const matches = lcsIndices(oldNorm, newNorm);
  const boundaries: Array<[number, number]> = [...matches, [oldTokens.length, newTokens.length]];

  const changes: TermChange[] = [];
  let oi = 0;
  let ni = 0;
  for (const [mi, mj] of boundaries) {
    const removed = oldTokens.slice(oi, mi).map(normalizeWord).join(" ");
    const added = newTokens.slice(ni, mj).map(normalizeWord).join(" ");
    if (removed && added && removed !== added) {
      changes.push({ oldTerm: removed, newTerm: added });
    }
    oi = mi + 1;
    ni = mj + 1;
  }

  const meaningfulChanges = changes.filter(
    (change) => change.oldTerm.length >= MIN_TERM_LENGTH && change.newTerm.length >= MIN_TERM_LENGTH,
  );
  if (meaningfulChanges.length === 0 || meaningfulChanges.length > MAX_TERM_CHANGES) return [];
  return meaningfulChanges;
}

/**
 * Pure in-memory string replace — no network/AI call involved. `replaceAll`
 * takes a literal string (not a RegExp) here, so it matches `oldTerm` as-is
 * without needing `\b` word-boundary regex, which doesn't work reliably for
 * Korean text.
 */
export function replaceAllOccurrences(text: string, oldTerm: string, newTerm: string): string {
  if (!oldTerm) return text;
  return text.replaceAll(oldTerm, newTerm);
}
