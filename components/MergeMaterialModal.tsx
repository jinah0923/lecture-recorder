"use client";

import { formatFileSize } from "@/lib/format";

// Confirmation before "자료 추가해서 다시 분석" replaces the current note —
// the rebuilt note doesn't carry over manual edits or merged deep-dive
// blocks, so the user has to know that before it runs.
export function MergeMaterialModal({
  files,
  onConfirm,
  onCancel,
}: {
  files: File[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
          이미 받아쓴 녹음 스크립트에 아래 자료를 합쳐 강의노트를 새로 만듭니다. 녹음은 다시 분석하지 않아요.
        </p>
        <ul className="mt-3 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">{file.name}</span>
              <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">{formatFileSize(file.size)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          ⚠️ 지금의 상세 강의노트·요약·체크리스트가 새 결과로 교체됩니다. 노트를 직접 수정했거나 심화 탐구 블록을 반영했다면 그
          내용은 새 노트에 남지 않으니, 필요하면 먼저 복사해 두세요. (체크리스트에서 같은 항목의 완료 표시는 유지돼요.)
        </p>
        <div className="mt-4 flex justify-end gap-2">
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
            autoFocus
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
          >
            병합 분석 시작
          </button>
        </div>
      </div>
    </div>
  );
}
