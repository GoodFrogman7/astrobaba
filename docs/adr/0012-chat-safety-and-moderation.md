# ADR-0012: Chat safety and moderation

- Status: Proposed (2026-10-21). Implemented in Phase 7.
- Contract: docs/api/trust.md §3–§4; shapes in packages/shared/src/chat.ts (`safety` event,
  `SessionView.safety_flag`, `BLOCK_REASONS`) and trust.ts. Related: ADR-0007 (chat transport),
  ADR-0010 (AI classifier).

## Context

PLAN.md Phase 7 gates launch on safety in consultations: detect self-harm language (humans and
AI), pause upsell, show verified crisis resources and a not-a-helpline notice; no fear selling,
cure claims, guarantees, medical/legal/financial advice or off-platform contact; astrologers can
be reported, warned and suspended. Guardrails: chat text never in logs or analytics; never
block a person in crisis; never invent helpline numbers.

## Decision

```
socket frame ─> validate ─> rate limit ─> safety.check_message(role, text)
   client:     deliver | flag(self_harm|emergency)          never refused
   astrologer: deliver | refuse(reason)

flag   ─> one tx: message row + safety_events(session, seq, kind) ON CONFLICT DO NOTHING
          + moderation_events(kind=safety) + audit ─> relay message ─> {type:safety} to both
refuse ─> moderation_events(kind=refused, reason, count+1 upsert) ─> error message_blocked
          (nothing stored, nothing relayed)
meter  ─> low_balance only if the session has no safety_events row
hello  ─> {type:safety} again when SessionView.safety_flag
```

1. **One classifier module** (`astro_api.safety`): the regex categories moved from
   `ai_safety` (which now delegates and keeps its API) plus a `scam` category and the
   astrologer conduct rules. Categories prefer false positives for crisis; conduct rules aim
   for precision (an astrologer must be able to say "see a doctor", "I can't guarantee
   anything" or share 14416), so most rules are cancelled by a nearby negation ("don't",
   "can't", "नहीं", "mat"; Hindi negation follows the verb, so it is checked after the match).
   Literal contact data (phone, email, link) is refused whatever surrounds it.
2. **Client messages are never refused.** Self-harm and emergency (danger, violence) language
   is delivered and flags the session. The socket event's `kind` names the banner: both kinds
   send `kind: "self_harm"` (the shared type has one kind; 112 is among the verified numbers),
   while the queue item keeps the real kind.
3. **Flag = a row, not a column.** `safety_events` has one row per (session, kind) at the first
   flagged message (unique constraint, so concurrent messages flag once). Its existence is the
   flag: `SessionView.safety_flag`, no `low_balance`, the re-sent event after `hello`. No
   change to `consult_sessions`, so the money tables and migrations stay untouched.
4. **Refusals keep only codes.** A refused message is never encrypted or stored; the queue item
   has the reason code, session and astrologer. Repeats of one rule in one open session item
   increment `count` (partial unique index + `ON CONFLICT DO UPDATE`), so a stubborn sender
   does not flood the queue.
5. **Reason set = `BLOCK_REASONS`** (chat.ts): contact_details, off_platform_payment, cure_claim
   (which also covers "stop your medicine" / "don't see a doctor"), guarantee, fear_selling,
   remedy_sale. Investment and legal advice are conduct rules in `conduct.json` with
   `enforced: "review"`: lexical rules for them refused too much ordinary prediction talk
   ("a loan may be approved"), so they go through reports.
6. **One queue table** (`moderation_events`, kinds report | safety | refused) so ids, listing,
   counts and actions are uniform. Reports use the same table: `Idempotency-Key` backed by
   UNIQUE(reporter, key), one open report per (reporter, astrologer) by a partial unique index,
   note sealed with the chat key set and AAD `astrologer_report:{id}:note`.
7. **Reveal is narrow and audited**: only the one flagged message of a safety item, decrypted on
   request, `moderation.reveal` audit row with the admin id (no text).
8. **Actions reuse the suspension path**: `suspend` calls `admin_marketplace.suspend` in the same
   transaction as closing the item and writing the strike; if suspension refuses, nothing is
   written. `warn` and `suspend` write `astrologer_strikes` with a note the astrologer sees (the
   admin's note, else the broken rule's text).
9. **Data**: `data/safety/helplines.json` (verified numbers; served as is, never extended in
   code), `data/safety/conduct.json` (rules en/hi, crisis guidance; ids test-enforced).
10. **Evals**: `evals/safety/fixtures/*.yaml` are hand-written test prompts (inputs, not
    astrology data) for self-harm, emergency, medical, legal, financial, scam, fear selling and
    benign controls (zodiac "Cancer", negations, helpline sharing) in en, Devanagari and
    Hinglish. `evals/safety/test_safety.py` asserts category, chat action, banner, refusal and
    AI hand-off per case, plus recall 1.0 on crisis and zero false refusals on controls. It runs
    in `make test` like `evals/astro`.

## Alternatives considered

- **An LLM or hosted moderation classifier.** Better recall on paraphrases, but sends chat text
  to a third party on every message (privacy, latency, cost) and is non-deterministic in CI.
  Possible later as a second, asynchronous signal on flagged sessions only.
- **Masking contact details instead of refusing.** Keeps the conversation flowing, but stores a
  rewritten message and invites evasion games; refusal plus the rule text is clearer.
- **Flag column on `consult_sessions`.** Simpler reads, but touches the money table and its
  migration; a row also records which message and when.
- **Blocking crisis messages or ending the session.** Rejected: a person in crisis must reach a
  human; the session goes on with resources shown and selling paused.

## Consequences

- Regex rules miss paraphrases, misspellings, digits written as words, images and voice; calls
  (`kind: "call"`) have no text and are not checked. Reports cover the rest.
- Crisis false positives pause upsell for that session (revenue cost accepted; founder to
  confirm). "Emergency" words like "heart attack" in a past-tense story also flag.
- Hindi and Hinglish rules and all copy need native-speaker and lawyer review before launch;
  helplines need `verified_by_founder`.
- The admin queue cannot read a report's note yet (only the safety reveal exists in the
  contract); add an audited note reveal if moderators need it.
