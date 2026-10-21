/** The page's IST date, machine-readable for the SEO check (title/description/body consistency). */
export function IstDate({ date, text }: { date: string; text: string }) {
  return (
    <time dateTime={date} data-ist-date={date}>
      {text}
    </time>
  );
}
