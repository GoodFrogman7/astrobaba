"use client";

import { CONTENT_KINDS, CONTENT_LOCALES, CONTENT_STATUSES, type ContentItem } from "@astro/shared";
import { useActionState, useState } from "react";
import {
  CONTENT_KIND_LABEL,
  CONTENT_LOCALE_LABEL,
  CONTENT_NOTES_MAX,
  CONTENT_STATUS_LABEL,
  CONTENT_TITLE_MAX,
  parseContentForm,
  type ContentFields,
} from "@/lib/growth-admin";
import type { ActionResult } from "@/lib/result";
import { saveContentItem } from "./actions";

const EMPTY: ContentFields = {
  title: "",
  kind: "article",
  locale: "both",
  status: "idea",
  due_date: "",
  url: "",
  notes: "",
};

function fieldsOf(item: ContentItem): ContentFields {
  return {
    title: item.title,
    kind: item.kind,
    locale: item.locale,
    status: item.status,
    due_date: item.due_date ?? "",
    url: item.url ?? "",
    notes: item.notes ?? "",
  };
}

/**
 * Create (no `item`) or edit a content item. The contract's rules are checked here before the
 * request is sent, and again by the Server Action and the API.
 */
export function ContentForm({
  item,
  initial,
  idPrefix,
}: {
  item?: ContentItem;
  initial?: Partial<ContentFields>;
  idPrefix: string;
}) {
  const start = item ? fieldsOf(item) : { ...EMPTY, ...initial };
  const [f, setF] = useState<ContentFields>(start);
  const [clientError, setClientError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: ActionResult | null, fd: FormData) => {
      const r = await saveContentItem(item?.id ?? null, prev, fd);
      if (r.ok && !item) setF(EMPTY);
      return r;
    },
    null,
  );
  const set = (k: keyof ContentFields) => (e: { target: { value: string } }) => {
    setF((prev) => ({ ...prev, [k]: e.target.value }));
    setClientError(null);
  };
  const id = (k: string) => `${idPrefix}-${k}`;
  const input = "mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1";

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const p = parseContentForm(f);
        if (!p.ok) {
          e.preventDefault();
          setClientError(p.error);
        }
      }}
      noValidate
      className="grid gap-3 sm:grid-cols-2"
    >
      <label htmlFor={id("title")} className="block text-sm sm:col-span-2">
        Title
        <input
          id={id("title")}
          name="title"
          required
          maxLength={CONTENT_TITLE_MAX}
          value={f.title}
          onChange={set("title")}
          className={input}
        />
      </label>
      <label htmlFor={id("kind")} className="block text-sm">
        Kind
        <select id={id("kind")} name="kind" value={f.kind} onChange={set("kind")} className={input}>
          {CONTENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {CONTENT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={id("locale")} className="block text-sm">
        Language
        <select
          id={id("locale")}
          name="locale"
          value={f.locale}
          onChange={set("locale")}
          className={input}
        >
          {CONTENT_LOCALES.map((l) => (
            <option key={l} value={l}>
              {CONTENT_LOCALE_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={id("status")} className="block text-sm">
        Status
        <select
          id={id("status")}
          name="status"
          value={f.status}
          onChange={set("status")}
          className={input}
        >
          {CONTENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONTENT_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={id("due")} className="block text-sm">
        Due date (IST)
        <input
          id={id("due")}
          name="due_date"
          type="date"
          value={f.due_date}
          onChange={set("due_date")}
          className={input}
        />
      </label>
      <label htmlFor={id("url")} className="block text-sm sm:col-span-2">
        URL {f.status === "published" ? "(required when published)" : "(optional)"}
        <input
          id={id("url")}
          name="url"
          required={f.status === "published"}
          placeholder="/learn/saturn-return or https://…"
          value={f.url}
          onChange={set("url")}
          className={input}
        />
        <span className="mt-0.5 block text-xs text-muted">
          A site path starting with / or an https:// link.
        </span>
      </label>
      <label htmlFor={id("notes")} className="block text-sm sm:col-span-2">
        Notes (optional)
        <textarea
          id={id("notes")}
          name="notes"
          rows={2}
          maxLength={CONTENT_NOTES_MAX}
          value={f.notes}
          onChange={set("notes")}
          className={input}
        />
        <span className="mt-0.5 block text-xs text-muted">
          {f.notes.length}/{CONTENT_NOTES_MAX}
        </span>
      </label>
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-fg disabled:opacity-60"
        >
          {item ? "Save changes" : "Add to calendar"}
        </button>
        <div role="status" aria-live="polite" className="mt-2 text-sm">
          {clientError ? (
            <span className="text-danger">{clientError}</span>
          ) : state?.ok === true ? (
            <span className="text-success">{state.message ?? "Saved."}</span>
          ) : state?.ok === false ? (
            <span className="text-danger">{state.error}</span>
          ) : null}
        </div>
      </div>
    </form>
  );
}
