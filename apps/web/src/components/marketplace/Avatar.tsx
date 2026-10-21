import { initials } from "@/lib/marketplace/format";

/** Photo placeholder: initials on the primary colour (photos arrive with the portal, Phase 5). */
export function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const cls = size === "lg" ? "h-20 w-20 text-2xl" : "h-12 w-12 text-base";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-fg ${cls}`}
    >
      {initials(name)}
    </span>
  );
}
