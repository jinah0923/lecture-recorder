"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { AccountModal } from "@/components/AccountModal";

/** Fixed top-right on every screen, to the left of ThemeToggle — same
 * layout-level placement rationale as that component. Shows the signed-in
 * user's Google avatar once authenticated, or a plain account icon
 * otherwise; either way it opens AccountModal, which carries the profile
 * details, sign-in/out, and manual sync action. */
export function AccountButton() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const [didSync, setDidSync] = useState(false);

  function handleClose() {
    setOpen(false);
    // A sync just wrote merged data into IndexedDB, but the rest of the app
    // only reads it once on mount — reload so the new data actually shows.
    if (didSync) window.location.reload();
  }

  const avatarUrl = status === "authenticated" ? session?.user?.image : null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDidSync(false);
          setOpen(true);
        }}
        aria-label="계정 및 동기화"
        title="계정 및 동기화"
        className="fixed right-16 top-[max(1rem,env(safe-area-inset-top))] z-50 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white text-base shadow-sm transition-colors hover:bg-slate-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          "☁️"
        )}
      </button>
      {open && <AccountModal onClose={handleClose} onSynced={() => setDidSync(true)} />}
    </>
  );
}
