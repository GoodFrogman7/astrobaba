import { StatusNotice } from "@/components/StatusNotice";
import { consolePage } from "@/lib/guard";
import { Console } from "./Console";

export const dynamic = "force-dynamic";

export default async function ConsoleHome() {
  const { access } = await consolePage(async () => null);
  if (access.kind === "anon") return null; // redirected to /login by the guard
  if (access.kind !== "live") return <StatusNotice access={access} />;
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Console</h1>
      <Console />
    </main>
  );
}
