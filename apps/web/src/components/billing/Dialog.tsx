"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Native modal dialog: the browser traps focus, closes on Escape and returns focus to the
 * button that opened it. Content renders only while open.
 */
export function Dialog({
  open,
  onClose,
  title,
  closeLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel?: string;
  children: ReactNode;
}) {
  const t = useTranslations("billing.start");
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={id}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border border-border bg-bg p-5 text-fg backdrop:bg-black/40"
    >
      {open && (
        <div className="space-y-4">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          {children}
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border px-4 py-2 text-sm"
          >
            {closeLabel ?? t("close")}
          </button>
        </div>
      )}
    </dialog>
  );
}
