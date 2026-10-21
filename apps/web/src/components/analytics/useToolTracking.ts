"use client";

import { useCallback, useEffect, useRef } from "react";
import { track } from "@/lib/analytics/client";

/**
 * tool_started on the first input in a tool form (pass the returned handler to the form's
 * onInput), tool_completed each time a new result is shown (docs/api/growth.md §1.1). Only the
 * tool slug and, for birth-chart tools, whether the birth time was unknown are sent: never what
 * the visitor typed. `unknownBirthTime` must be derived from `result`.
 */
export function useToolTracking(tool: string, result: unknown, unknownBirthTime?: boolean) {
  const started = useRef(false);
  const onInput = useCallback(() => {
    if (started.current) return;
    started.current = true;
    track("tool_started", { tool });
  }, [tool]);

  useEffect(() => {
    if (result === null || result === undefined) return;
    track(
      "tool_completed",
      unknownBirthTime === undefined ? { tool } : { tool, unknown_birth_time: unknownBirthTime },
    );
  }, [result, tool, unknownBirthTime]);

  return onInput;
}
