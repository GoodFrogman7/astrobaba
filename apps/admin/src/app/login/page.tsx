import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main id="main" className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">Admin sign in</h1>
      <p className="mt-2 text-sm text-muted">
        We text a one-time code to your number. Only accounts with the admin role can continue.
      </p>
      <LoginForm />
    </main>
  );
}
