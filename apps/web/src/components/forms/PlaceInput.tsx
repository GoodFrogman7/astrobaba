"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

export interface PlaceValue {
  lat: number;
  lon: number;
  tz: string;
  label: string;
  city_id: number;
}

interface CityResult {
  id: number;
  label: string;
  lat: number;
  lon: number;
  tz: string;
}

/** Accessible place combobox backed by /api/cities (GeoNames via the astro engine). */
export function PlaceInput({
  value,
  onChange,
  invalid,
  describedBy,
  inputId,
}: {
  value: PlaceValue | null;
  onChange: (v: PlaceValue | null) => void;
  invalid?: boolean;
  describedBy?: string;
  inputId?: string;
}) {
  const t = useTranslations("toolsUi.form");
  const id = useId();
  const [query, setQuery] = useState(value?.label ?? "");
  const [results, setResults] = useState<CityResult[]>([]);
  const [attribution, setAttribution] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Debounced search, started from the input handler (not an effect).
  function search(text: string) {
    if (timer.current) clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/cities?q=${encodeURIComponent(q)}`);
        const body = (await res.json()) as { results?: CityResult[]; attribution?: string };
        setResults(body.results ?? []);
        setAttribution(body.attribution ?? "");
        setOpen(true);
        setActive(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 200);
  }

  function choose(c: CityResult) {
    onChange({ lat: c.lat, lon: c.lon, tz: c.tz, label: c.label, city_id: c.id });
    setQuery(c.label);
    setOpen(false);
  }

  const listId = `${id}-list`;
  return (
    <div className="relative">
      <input
        id={inputId ?? `${id}-input`}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        placeholder={t("placeHint")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value) onChange(null);
          search(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!open || results.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            const r = results[active];
            if (r) choose(r);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded-sm border border-border bg-surface px-3 py-2"
      />
      {loading && <p className="mt-1 text-xs text-muted">{t("placeSearching")}</p>}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-sm border border-border bg-surface shadow"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">{t("placeNone")}</li>
          ) : (
            results.map((r, i) => (
              <li
                key={r.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r);
                }}
                className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-bg" : ""}`}
              >
                {r.label}
              </li>
            ))
          )}
          {attribution && <li className="px-3 py-1 text-[11px] text-muted">{attribution}</li>}
        </ul>
      )}
      {value && <p className="mt-1 text-xs text-muted">{t("timeZone", { tz: value.tz })}</p>}
    </div>
  );
}
