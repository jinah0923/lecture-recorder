"use client";

import { useRef, useState } from "react";
import { formatFileSize } from "@/lib/format";
import type { ReferenceDocument } from "@/lib/types";

const ACCEPTED = ".pdf,.txt,image/*,application/pdf,text/plain";

type ReferenceDocDropzoneProps = {
  document: ReferenceDocument | null;
  onDocumentChange: (doc: ReferenceDocument) => void;
  onClear: () => void;
};

export function ReferenceDocDropzone({ document, onDocumentChange, onClear }: ReferenceDocDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function applyFile(file: File) {
    onDocumentChange({
      name: file.name,
      sizeLabel: formatFileSize(file.size),
      mimeType: file.type || "application/octet-stream",
      blob: file,
    });
  }

  function openPicker() {
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
          const file = event.dataTransfer.files[0];
          if (file) applyFile(file);
        }}
        className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-6 text-center transition ${
          isDragging
            ? "border-indigo-400 bg-indigo-50"
            : "border-zinc-200 bg-zinc-50 hover:border-zinc-300 hover:bg-zinc-100/70"
        }`}
      >
        {document ? (
          <div className="flex w-full max-w-full items-start justify-center gap-2 px-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-800">{document.name}</p>
              <p className="mt-1 text-xs text-zinc-500">{document.sizeLabel} · click or drop to replace</p>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClear();
              }}
              aria-label="첨부 자료 제거"
              className="shrink-0 rounded-full p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-500"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-zinc-800">강의안 파일을 올려주세요</p>
            <p className="mt-1 text-xs text-zinc-500">PDF, TXT, 이미지 (PPT는 PDF로 변환 후 업로드)</p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) applyFile(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}
