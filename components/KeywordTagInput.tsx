"use client";

import { useState } from "react";

type KeywordTagInputProps = {
  keywords: string[];
  onChange: (keywords: string[]) => void;
};

export function KeywordTagInput({ keywords, onChange }: KeywordTagInputProps) {
  const [draft, setDraft] = useState("");

  // Merge one or more new words into keywords in a single onChange call.
  // Calling onChange repeatedly from stale closures (e.g. once per comma in
  // a pasted/typed batch) would have each call overwrite the previous one.
  function addKeywords(words: string[]) {
    const merged = [...keywords];
    for (const raw of words) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (merged.some((k) => k.toLowerCase() === trimmed.toLowerCase())) continue;
      merged.push(trimmed);
    }
    if (merged.length !== keywords.length) onChange(merged);
  }

  function removeKeyword(word: string) {
    onChange(keywords.filter((k) => k !== word));
  }

  function handleChange(value: string) {
    if (value.includes(",")) {
      const parts = value.split(",");
      const remainder = parts.pop() ?? "";
      addKeywords(parts);
      setDraft(remainder);
    } else {
      setDraft(value);
    }
  }

  function commitDraft() {
    if (!draft.trim()) return;
    addKeywords([draft]);
    setDraft("");
  }

  return (
    <div>
      {keywords.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {keywords.map((word) => (
            <span
              key={word}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
            >
              {word}
              <button
                type="button"
                onClick={() => removeKeyword(word)}
                aria-label={`${word} 제거`}
                className="text-indigo-400 transition hover:text-indigo-700 dark:text-indigo-500 dark:hover:text-indigo-300"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
          }
        }}
        onBlur={commitDraft}
        placeholder="예: 광합성, 캘빈회로, 루비스코"
        className="w-full rounded-lg border border-zinc-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">쉼표 또는 Enter로 용어를 추가하세요</p>
    </div>
  );
}
