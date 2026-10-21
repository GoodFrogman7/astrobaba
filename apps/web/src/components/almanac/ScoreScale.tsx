/** A score on the fixed 5-step scale: five marks plus the same value in words (never colour only). */
export function ScoreScale({ score, text, label }: { score: number; text: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span role="img" aria-label={`${label}: ${text}`} className="flex gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`inline-block h-2.5 w-6 rounded-sm ${i <= score ? "bg-primary" : "bg-border"}`}
          />
        ))}
      </span>
      <span className="text-sm font-medium">{text}</span>
    </div>
  );
}
