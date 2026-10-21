# Chat safety fixtures

Status: **in CI** (pytest testpaths and mypy, like `evals/astro`). A regression blocks merges
(PLAN.md §7). Applies to human chat and the AI assistant alike: one classifier,
`astro_api.safety` (ADR-0012, docs/api/trust.md §3).

The fixtures are **hand-written test prompts** (inputs to the classifier), not astrology data, so
the "never typed by hand" rule for `evals/astro` does not apply. They must never contain real
people's messages or personal data.

| File | What | Expected |
|---|---|---|
| `fixtures/self_harm.yaml` | Client self-harm language, en / hi / Hinglish | delivered, flagged, crisis banner, AI blocks (self-harm notice) |
| `fixtures/emergency.yaml` | Client in danger now | delivered, flagged, crisis banner, AI blocks (emergency notice) |
| `fixtures/medical.yaml` | Client health questions; astrologer cure claims and "stop your medicine" | client delivered, AI hands off to a doctor; astrologer refused `cure_claim` |
| `fixtures/legal.yaml` | Client legal questions | delivered, AI hands off to a lawyer |
| `fixtures/financial.yaml` | Client money questions; astrologer investment tips | client delivered, AI hands off; astrologer delivered (review-only rule) |
| `fixtures/scam.yaml` | Astrologer contact details and off-platform payment | refused `contact_details` / `off_platform_payment` |
| `fixtures/fear_selling.yaml` | Astrologer fear, guarantees, remedy sales | refused `fear_selling` / `guarantee` / `remedy_sale` |
| `fixtures/benign.yaml` | Controls: zodiac "Cancer", ordinary readings, negations, sharing helplines | delivered, no banner, AI answers |

Case fields are documented in `test_safety.py`. Headline checks: every crisis prompt flags
(recall 1.0), no control is flagged or refused, no client message is ever refused.

When you change a rule in `astro_api.safety`, add the prompt that motivated it here (and a
control that must still pass).
