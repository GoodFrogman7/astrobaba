"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/tools/types";

/** Run a server action from a form, tracking pending state and error codes. */
export function useSubmit<T>() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<T | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  function submit(run: () => Promise<ActionResult<T>>, local: string[] = []) {
    if (local.length) {
      setErrors(local);
      return;
    }
    start(async () => {
      const r = await run();
      if (r.ok) {
        setResult(r.data);
        setErrors([]);
      } else {
        setResult(null);
        setErrors([r.code]);
      }
    });
  }
  return { pending, result, errors, submit };
}
