"use client";

import { useRef, useState } from "react";
import { formatFileSize } from "@/lib/format";
import type { ReferenceDocument } from "@/lib/types";

const ACCEPTED = ".pdf,.txt,image/*,application/pdf,text/plain";
export const MAX_REFERENCE_DOCUMENTS = 5;
const MAX_DOCS_MESSAGE = "최대 5개까지만 첨부할 수 있습니다.";

type ReferenceDocDropzoneProps = {
  documents: ReferenceDocument[];
  onDocumentsChange: (docs: ReferenceDocument[]) => void;
  onRemove: (index: number) => void;
};

export function ReferenceDocDropzone({ documents, onDocumentsChange, onRemove }: ReferenceDocDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function applyFiles(fileList: FileList) {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    const availableSlots = MAX_REFERENCE_DOCUMENTS - documents.length;
    if (availableSlots <= 0) {
      window.alert(MAX_DOCS_MESSAGE);
      return;
    }
    if (incoming.length > availableSlots) {
      window.alert(MAX_DOCS_MESSAGE);
    }

    const accepted = incoming.slice(0, availableSlots).map(
      (file): ReferenceDocument => ({
        name: file.name,
        sizeLabel: formatFileSize(file.size),
        mimeType: file.type || "application/octet-stream",
        blob: file,
      }),
    );
    onDocumentsChange([...documents, ...accepted]);
  }

  function openPicker() {
    if (documents.length >= MAX_REFERENCE_DOCUMENTS) {
      window.alert(MAX_DOCS_MESSAGE);
      return;
    }
    inputRef.current?.click();
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") openPicker();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          applyFiles(event.dataTransfer.files);
        }}
        className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-6 text-center transition ${
          isDragging
            ? "border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/30"
            : "border-slate-200 bg-zinc-50 hover:border-zinc-300 hover:bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-800/40 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/70"
        }`}
      >
        {documents.length > 0 ? (
          <div className="flex w-full flex-col gap-1.5 px-1">
            {documents.map((doc, index) => (
              <div
                key={`${doc.name}-${index}`}
                className="flex w-full items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-left shadow-sm dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{doc.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{doc.sizeLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(index);
                  }}
                  aria-label={`${doc.name} 제거`}
                  className="shrink-0 rounded-full p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-500 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {documents.length}/{MAX_REFERENCE_DOCUMENTS}개 첨부됨
              {documents.length < MAX_REFERENCE_DOCUMENTS && " · 클릭하거나 파일을 끌어다 놓아 추가"}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">강의안 파일을 올려주세요</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              PDF, TXT, 이미지 · 최대 {MAX_REFERENCE_DOCUMENTS}개 (PPT는 PDF로 변환 후 업로드)
            </p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) applyFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
