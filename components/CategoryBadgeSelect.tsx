"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type CategoryBadgeSelectProps = {
  category: string;
  categories: string[];
  onChange: (category: string) => void;
  onCreateAndSelect: (name: string) => void;
};

export function CategoryBadgeSelect({
  category,
  categories,
  onChange,
  onCreateAndSelect,
}: CategoryBadgeSelectProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function closeAll() {
    setOpen(false);
    setCreating(false);
    setNewName("");
    setError(null);
  }

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closeAll();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeAll();
    }
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  function handleSelect(name: string) {
    if (name !== category) onChange(name);
    closeAll();
  }

  function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("카테고리 이름을 입력해주세요.");
      return;
    }
    if (categories.some((name) => name.toLowerCase() === trimmed.toLowerCase())) {
      setError("이미 존재하는 카테고리입니다.");
      return;
    }
    onCreateAndSelect(trimmed);
    closeAll();
  }

  return (
    <div className="relative inline-block" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/70"
      >
        {category}
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <ul className="max-h-48 overflow-y-auto">
            {categories.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => handleSelect(name)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                    name === category ? "font-medium text-indigo-600 dark:text-indigo-400" : "text-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  <span className="truncate">{name}</span>
                  {name === category && (
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-1 border-t border-zinc-100 pt-1 dark:border-zinc-800">
            {creating ? (
              <form onSubmit={handleCreateSubmit} className="flex flex-col gap-1.5 px-1 py-1">
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value);
                    setError(null);
                  }}
                  placeholder="새 카테고리 이름"
                  className="w-full rounded-lg border border-zinc-200 bg-slate-100 px-2 py-1 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
                {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setError(null);
                    }}
                    className="rounded-full px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    className="rounded-full bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                  >
                    이동
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-indigo-600 transition hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
              >
                + 새 카테고리로 이동
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
