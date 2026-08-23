"use client";

import { useState } from "react";
import type { ChecklistItem } from "@/lib/types";

type ChecklistPanelProps = {
  checklist: ChecklistItem[];
  /** Always receives the full, updated array — the caller's own debounced
   * autosave effect (keyed on aiResult) is what actually lands this in
   * IndexedDB, same as the lecture-note/transcript editors. */
  onChange: (nextChecklist: ChecklistItem[]) => void;
};

export function ChecklistPanel({ checklist, onChange }: ChecklistPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");

  function toggleDone(id: string) {
    onChange(checklist.map((item) => (item.id === id ? { ...item, done: !item.done } : item)));
  }

  function startEditing(item: ChecklistItem) {
    setEditingId(item.id);
    setDraftText(item.text);
  }

  function commitEdit(id: string) {
    const trimmed = draftText.trim();
    // Blurring/confirming an item left empty just removes it instead of
    // persisting a blank checklist row.
    if (!trimmed) {
      onChange(checklist.filter((item) => item.id !== id));
    } else {
      onChange(checklist.map((item) => (item.id === id ? { ...item, text: trimmed } : item)));
    }
    setEditingId(null);
  }

  function handleAdd() {
    const newItem: ChecklistItem = { id: crypto.randomUUID(), text: "", done: false };
    onChange([...checklist, newItem]);
    setEditingId(newItem.id);
    setDraftText("");
  }

  function handleDelete(id: string) {
    onChange(checklist.filter((item) => item.id !== id));
    if (editingId === id) setEditingId(null);
  }

  return (
    <div>
      {checklist.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">생성된 체크리스트가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {checklist.map((item) => (
            <li
              key={item.id}
              className="group flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm transition-colors dark:bg-zinc-800/60"
            >
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => toggleDone(item.id)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500 dark:border-zinc-600 dark:bg-zinc-900"
              />
              {editingId === item.id ? (
                <input
                  autoFocus
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  onBlur={() => commitEdit(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  placeholder="체크리스트 내용을 입력하세요"
                  className="flex-1 rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-sm text-zinc-900 outline-none dark:border-indigo-700 dark:bg-zinc-800 dark:text-zinc-100"
                />
              ) : (
                <p
                  onClick={() => startEditing(item)}
                  title="클릭해서 수정"
                  className={`flex-1 cursor-text rounded px-1.5 py-0.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
                    item.done ? "text-zinc-400 line-through dark:text-zinc-600" : "text-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  {item.text}
                </p>
              )}
              <button
                type="button"
                onClick={() => handleDelete(item.id)}
                aria-label="체크리스트 항목 삭제"
                title="삭제"
                className="shrink-0 rounded-full p-1 text-zinc-300 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100 dark:text-zinc-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={handleAdd}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-slate-200 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/40 dark:hover:text-indigo-300"
      >
        + 새 체크리스트 추가
      </button>
    </div>
  );
}
