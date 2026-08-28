"use client";

import { useState } from "react";
import { SyncKeyModal } from "@/components/SyncKeyModal";

/** Fixed top-right on every screen, to the left of ThemeToggle — same
 * layout-level placement rationale as that component. */
export function SyncButton() {
  const [open, setOpen] = useState(false);
  const [didSync, setDidSync] = useState(false);

  function handleClose() {
    setOpen(false);
    // A sync just wrote merged data into IndexedDB, but the rest of the app
    // only reads it once on mount — reload so the new data actually shows.
    if (didSync) window.location.reload();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDidSync(false);
          setOpen(true);
        }}
        aria-label="기기 간 동기화"
        title="기기 간 동기화"
        className="fixed right-16 top-[max(1rem,env(safe-area-inset-top))] z-50 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-base shadow-sm transition-colors hover:bg-slate-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        ☁️
      </button>
      {open && <SyncKeyModal onClose={handleClose} onSynced={() => setDidSync(true)} />}
    </>
  );
}
