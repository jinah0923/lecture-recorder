"use client";

import { useRef } from "react";

type ReattachAudioPromptProps = {
  audioFileName: string;
  onFileSelected: (file: File) => void;
};

export function ReattachAudioPrompt({ audioFileName, onFileSelected }: ReattachAudioPromptProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-200 bg-white p-6 text-center shadow-sm">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-xl">📁</span>
      <div>
        <p className="text-sm font-medium text-zinc-700">오디오가 기기에 저장되어 있어요</p>
        <p className="mt-1 text-xs text-zinc-400">
          다운로드 폴더에서{" "}
          <span className="font-mono text-zinc-600">{audioFileName || "저장된 파일"}</span>
          {" "}을(를) 찾아 다시 선택해주세요
        </p>
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
      >
        📁 기기에 저장된 오디오 파일 불러오기
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFileSelected(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}
