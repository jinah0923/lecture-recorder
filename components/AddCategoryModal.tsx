"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type AddCategoryModalProps = {
  existingCategories: string[];
  onSubmit: (name: string) => void;
  onClose: () => void;
};

export function AddCategoryModal({ existingCategories, onSubmit, onClose }: AddCategoryModalProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("카테고리 이름을 입력해주세요.");
      return;
    }
    if (existingCategories.some((category) => category.toLowerCase() === trimmed.toLowerCase())) {
      setError("이미 존재하는 카테고리입니다.");
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-slate-50 p-5 shadow-xl dark:bg-zinc-900"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-category-title"
      >
        <h2 id="add-category-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          카테고리 추가
        </h2>
        <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2">
          <input
            ref={inputRef}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder="예: 자료구조, 알고리즘"
            className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-300 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              취소
            </button>
            <button
              type="submit"
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
            >
              추가
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
