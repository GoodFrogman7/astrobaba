"use client";

import { AVAILABILITY_LIMITS, type Availability, type AvailabilitySlot } from "@astro/shared";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  addSlot,
  copyDay,
  groupByDay,
  invalidSlotIndex,
  removeSlot,
  sameSchedule,
  timeOptions,
  updateSlot,
  validateSlots,
  weekdayLabel,
} from "@/lib/availability";

const STARTS = timeOptions("start");
const ENDS = timeOptions("end");
const WEEKDAYS_ONLY = [0, 1, 2, 3, 4] as const;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function withValue(options: string[], v: string): string[] {
  return options.includes(v) ? options : [v, ...options];
}

export function ScheduleEditor({ initial }: { initial: AvailabilitySlot[] }) {
  const router = useRouter();
  const [saved, setSaved] = useState<AvailabilitySlot[]>(initial);
  const [slots, setSlots] = useState<AvailabilitySlot[]>(initial);
  const [serverIssue, setServerIssue] = useState<{ index: number; message: string } | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const validation = useMemo(() => validateSlots(slots), [slots]);
  const dirty = !sameSchedule(slots, saved);
  const issueAt = (i: number) =>
    validation.issues.find((x) => x.index === i)?.message ??
    (serverIssue?.index === i ? serverIssue.message : null);

  // Unsaved changes: ask before leaving the page.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function edit(next: AvailabilitySlot[] | null, failText?: string) {
    if (!next) {
      setStatus({ ok: false, text: failText ?? "That change is not possible." });
      return;
    }
    setSlots(next);
    setServerIssue(null);
    setStatus(null);
  }

  async function save() {
    if (!validation.ok || saving) return;
    setSaving(true);
    setStatus(null);
    setServerIssue(null);
    try {
      const r = await fetch("/api/portal/availability", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Sent in editing order, so an index in a 422 points at the row on screen.
        body: JSON.stringify({ slots }),
      });
      const body = (await r.json().catch(() => ({}))) as Partial<Availability> & {
        code?: string;
        message?: string;
      };
      if (r.status === 401) {
        router.replace("/login");
        return;
      }
      if (r.ok) {
        const next = Array.isArray(body.slots) ? body.slots : slots;
        setSaved(next);
        setSlots(next);
        setStatus({ ok: true, text: "Schedule saved. Your profile shows it now." });
        return;
      }
      if (body.code === "invalid_slots") {
        const index = invalidSlotIndex(body, slots.length);
        const message = body.message || "This slot is not valid.";
        if (index !== null) setServerIssue({ index, message });
        setStatus({
          ok: false,
          text:
            index !== null
              ? `Not saved: ${weekdayLabel(slots[index]!.weekday)} slot ${slots[index]!.start}–${slots[index]!.end} needs fixing.`
              : `Not saved: ${message}`,
        });
        return;
      }
      setStatus({
        ok: false,
        text:
          body.code === "api_unavailable"
            ? "The service is unreachable. Your changes are still here; try again in a moment."
            : `Not saved: ${body.message ?? "something went wrong"}. Try again.`,
      });
    } catch {
      setStatus({ ok: false, text: "Network error. Your changes are still here; try again." });
    } finally {
      setSaving(false);
    }
  }

  const days = groupByDay(slots);
  const full = slots.length >= AVAILABILITY_LIMITS.maxSlots;

  return (
    <div className="mt-6 space-y-4">
      <p className="text-sm">
        {slots.length} of {AVAILABILITY_LIMITS.maxSlots} slots used. Times move in 15-minute steps.
        For an overnight shift, add two slots: until 24:00 on one day, and from 00:00 the next.
      </p>
      {validation.tooMany && (
        <p role="alert" className="text-sm text-danger">
          {validation.tooMany}
        </p>
      )}

      <ol className="space-y-3">
        {days.map((day) => (
          <li key={day.weekday} className="rounded-md border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold" id={`day-${day.weekday}`}>
                {day.label}
              </h2>
              <div className="flex flex-wrap gap-2 text-sm">
                {day.entries.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        edit(
                          copyDay(slots, day.weekday, WEEKDAYS_ONLY),
                          `Copying would go over ${AVAILABILITY_LIMITS.maxSlots} slots.`,
                        )
                      }
                      className="rounded-sm border border-border px-2 py-1"
                    >
                      Copy to Mon–Fri
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        edit(
                          copyDay(slots, day.weekday, ALL_DAYS),
                          `Copying would go over ${AVAILABILITY_LIMITS.maxSlots} slots.`,
                        )
                      }
                      className="rounded-sm border border-border px-2 py-1"
                    >
                      Copy to every day
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={full}
                  onClick={() =>
                    edit(addSlot(slots, day.weekday), `${day.label} has no free time left.`)
                  }
                  className="rounded-sm bg-primary px-2 py-1 text-primary-fg disabled:opacity-60"
                >
                  Add slot
                </button>
              </div>
            </div>
            {day.entries.length === 0 ? (
              <p className="mt-2 text-sm text-muted">Not available.</p>
            ) : (
              <ul className="mt-3 space-y-2" aria-labelledby={`day-${day.weekday}`}>
                {day.entries.map(({ slot, index }) => {
                  const issue = issueAt(index);
                  const errId = `slot-${index}-error`;
                  return (
                    <li key={index}>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="text-sm">
                          <span className="block text-muted">From</span>
                          <select
                            value={slot.start}
                            aria-invalid={issue ? true : undefined}
                            aria-describedby={issue ? errId : undefined}
                            onChange={(e) =>
                              edit(updateSlot(slots, index, { start: e.target.value }))
                            }
                            className="mt-1 rounded-sm border border-border bg-bg px-2 py-1 font-mono"
                          >
                            {withValue(STARTS, slot.start).map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-sm">
                          <span className="block text-muted">Until</span>
                          <select
                            value={slot.end}
                            aria-invalid={issue ? true : undefined}
                            aria-describedby={issue ? errId : undefined}
                            onChange={(e) =>
                              edit(updateSlot(slots, index, { end: e.target.value }))
                            }
                            className="mt-1 rounded-sm border border-border bg-bg px-2 py-1 font-mono"
                          >
                            {withValue(ENDS, slot.end).map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() => edit(removeSlot(slots, index))}
                          className="rounded-sm border border-border px-2 py-1 text-sm"
                          aria-label={`Remove ${day.label} ${slot.start}–${slot.end}`}
                        >
                          Remove
                        </button>
                      </div>
                      {issue && (
                        <p id={errId} className="mt-1 text-sm text-danger">
                          {issue}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-bg py-3">
        <button
          type="button"
          disabled={!dirty || !validation.ok || saving}
          onClick={() => void save()}
          className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => {
            setSlots(saved);
            setServerIssue(null);
            setStatus(null);
          }}
          className="rounded-sm border border-border px-4 py-2 disabled:opacity-60"
        >
          Discard changes
        </button>
        {dirty && validation.ok && !status && (
          <span className="text-sm text-muted">Unsaved changes</span>
        )}
        {!validation.ok && !validation.tooMany && (
          <span className="text-sm text-danger">Fix the highlighted slots to save.</span>
        )}
        <span role="status" aria-live="polite" className="text-sm">
          {status && (
            <span className={status.ok ? "text-success" : "text-danger"}>{status.text}</span>
          )}
        </span>
      </div>
    </div>
  );
}
