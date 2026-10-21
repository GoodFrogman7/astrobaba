export function LoadError({ error }: { error: string }) {
  return (
    <p role="alert" className="mt-6 rounded-md border border-danger px-4 py-3 text-sm text-danger">
      Could not load this list: {error}
    </p>
  );
}
