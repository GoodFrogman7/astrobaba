"use client";

import { CHAT_LIMITS } from "@astro/shared";
import { useTranslations } from "next-intl";
import { forwardRef, useId, useState } from "react";

/** Enter sends, Shift+Enter adds a line. The draft is cleared only once the send is queued. */
export const Composer = forwardRef<
  HTMLTextAreaElement,
  { disabled: boolean; onSend: (text: string) => boolean; onTyping: () => void }
>(function Composer({ disabled, onSend, onTyping }, ref) {
  const t = useTranslations("billing.chat");
  const [text, setText] = useState("");
  const id = useId();
  const max = CHAT_LIMITS.maxMessageChars;
  function submit() {
    if (disabled) return;
    if (onSend(text)) setText("");
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-1"
    >
      <label htmlFor={id} className="sr-only">
        {t("label")}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={id}
          ref={ref}
          rows={2}
          value={text}
          maxLength={max}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setText(e.target.value);
            onTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="min-h-11 flex-1 resize-y rounded-sm border border-border bg-surface px-3 py-2"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
        >
          {t("send")}
        </button>
      </div>
      <p id={`${id}-hint`} className="flex justify-between text-xs text-muted">
        <span>{t("hint")}</span>
        <span>{t("chars", { count: text.length, max })}</span>
      </p>
    </form>
  );
});
