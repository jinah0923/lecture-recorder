"use client";

import { useRef } from "react";
import { formatFileSize } from "@/lib/format";

// "자료 추가해서 다시 분석" — opened before any file is picked, so it offers
// both ways of rebuilding the note: with newly attached material, or from
// the saved transcript alone ("자료 없이 스크립트만 재분석"). Either way the
// rebuilt note doesn't carry over manual edits or merged deep-dive blocks,
// so the user has to know that before it runs.
export function MergeMaterialModal({
  files,
  onFilesPicked,
  onRemoveFile,
  onConfirm,
  onScriptOnly,
  onCancel,
}: {
  files: File[];
  /** Validated by the caller (count, type). */
  onFilesPicked: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onConfirm: () => void;
  onScriptOnly: () => void;
  onCancel: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasFiles = files.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:px-4 sm:py-8"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-slate-50 p-5 shadow-xl sm:rounded-2xl dark:bg-zinc-900"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-material-title"
      >
        <h2 id="merge-material-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          📄 자료 추가해서 다시 분석
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          이미 받아쓴 녹음 스크립트에 교안·교재를 합쳐 강의노트를 새로 만듭니다. 녹음은 다시 분석하지 않아요.
        </p>

        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
          {hasFiles ? (
            <ul className="flex flex-col gap-1">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{file.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">{formatFileSize(file.size)}</span>
                    <button
                      type="button"
                      onClick={() => onRemoveFile(index)}
                      aria-label={`${file.name} 빼기`}
                      className="rounded-full px-1.5 text-xs text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-1 text-center text-xs text-zinc-400 dark:text-zinc-500">선택한 자료가 없습니다</p>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 w-full rounded-lg border border-dashed border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
          >
            ＋ PDF·이미지 자료 선택
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf,image/*"
            multiple
            onChange={(event) => {
              const picked = Array.from(event.target.files ?? []);
              // Cleared so picking the same file again still fires onChange.
              event.target.value = "";
              if (picked.length > 0) onFilesPicked(picked);
            }}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>

        <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
          <span className="h-px flex-1 bg-slate-200 dark:bg-zinc-700" />
          또는
          <span className="h-px flex-1 bg-slate-200 dark:bg-zinc-700" />
        </div>
        <button
          type="button"
          onClick={onScriptOnly}
          className="mt-2 w-full rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          자료 없이 스크립트만 재분석
        </button>
        <p className="mt-1 text-center text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
          오디오 처리를 생략하고 텍스트만 다시 요약하여 토큰을 절약합니다. 처음 분석 때 첨부한 자료는 다시 쓰이지 않아요.
        </p>

        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          ⚠️ 지금의 상세 강의노트·요약·체크리스트가 새 결과로 교체됩니다. 노트를 직접 수정했거나 심화 탐구 블록을 반영했다면 그
          내용은 새 노트에 남지 않으니, 필요하면 먼저 복사해 두세요. (체크리스트에서 같은 항목의 완료 표시는 유지돼요.)
        </p>

        <div className="mt-4">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-full border border-slate-200 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              취소
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!hasFiles}
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-indigo-300 dark:disabled:bg-indigo-900"
            >
              병합 분석 시작
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
