"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const MESSAGES: Record<string, string> = {
  unsupported_phone: "Enter an Indian mobile number.",
  rate_limited: "Too many attempts. Wait a little and try again.",
  invalid_code: "That code is not correct.",
  challenge_expired: "The code has expired. Request a new one.",
  not_admin: "This account does not have the admin role.",
};

export function LoginForm() {
  const router = useRouter();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { code?: string; challenge_id?: string };
      if (!res.ok) setError(MESSAGES[data.code ?? ""] ?? "Something went wrong. Try again.");
      return res.ok ? data : null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      {!challenge ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const phone = String(new FormData(e.currentTarget).get("phone") ?? "");
            const data = await post("/api/auth/otp/request", { phone });
            if (data?.challenge_id) setChallenge(data.challenge_id);
          }}
          className="space-y-3"
        >
          <label className="block text-sm font-medium" htmlFor="phone">
            Mobile number
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            className="w-full rounded-sm border border-border bg-surface px-3 py-2"
          />
          <button
            disabled={busy}
            className="w-full rounded-sm bg-primary px-3 py-2 text-primary-fg disabled:opacity-60"
          >
            Send code
          </button>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const code = String(new FormData(e.currentTarget).get("code") ?? "");
            const data = await post("/api/auth/otp/verify", { challenge_id: challenge, code });
            if (data) {
              // Drop any route data fetched while signed out (it redirected to /login).
              router.refresh();
              router.replace("/");
            }
          }}
          className="space-y-3"
        >
          <label className="block text-sm font-medium" htmlFor="code">
            6-digit code
          </label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            required
            className="w-full rounded-sm border border-border bg-surface px-3 py-2 tracking-widest"
          />
          <button
            disabled={busy}
            className="w-full rounded-sm bg-primary px-3 py-2 text-primary-fg disabled:opacity-60"
          >
            Sign in
          </button>
        </form>
      )}
      <p role="alert" aria-live="assertive" className="text-sm text-danger">
        {error}
      </p>
    </div>
  );
}
