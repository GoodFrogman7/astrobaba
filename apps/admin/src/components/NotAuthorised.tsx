export function NotAuthorised() {
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold">Not authorised</h1>
      <p className="mt-3 text-muted">
        This account does not have the admin role. Ask an existing admin to grant it, then sign in
        again.
      </p>
      <form action="/api/auth/logout" method="post" className="mt-6">
        <button className="rounded-sm border border-border px-3 py-2">Sign out</button>
      </form>
    </main>
  );
}
