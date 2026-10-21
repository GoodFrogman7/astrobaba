# ADR-0010: AI assistant (questions about a saved kundli)

- Status: Accepted (behind flag `ai_assistant`, off; launch is a founder decision, PLAN.md §9.4)
- Date: 2026-10-21

## Context

PLAN.md §1 uses a clearly labelled AI assistant for cold start: cheap, instant first answers
grounded on the user's computed chart, with a hand-off to human astrologers. The guardrails
(§0.4, §6, Phase 7) are strict: astro values only from the engine, every AI answer labelled and
never presented as a person, no medical/legal/financial advice, no fear or remedy selling, no
chat content in logs or training data, paid no-training LLM tiers only. Money moves only with a
ledger entry and an idempotency key. Contract: docs/api/revenue.md §3.

## Decision

```
POST question ──> classify (ai_safety) ── blocked ──> stored `blocked`, NOT charged, no job,
      │                                               fixed notice (self-harm: people to contact)
      │ ok
      ▼  one transaction
 question row (encrypted) + charge `ai:{id}:charge` + job `ai:{id}:answer` (ids only)
      │                                        402 insufficient_funds: nothing written
      ▼  worker
 decrypt ─> classify again ─> engine facts ─> LLM (facts + fenced question) ─> rules + grounding
                │ blocked          │ error          │ error                        │ invalid
                ▼                  ▼                ▼                              ▼ retry once
           blocked + refund   job retries (backoff, 5 attempts) ─> on_failed:   blocked(other)
                                                                  failed + refund  + refund
      valid ─> `answered`: answer encrypted, AI label + hand-off line stored with it
```

1. **Pre-LLM classifier** (`astro_api.ai_safety.classify`): regex sets in English, Hindi
   (Devanagari, nukta/chandrabindu folded) and common Hinglish, in priority order self-harm,
   emergency, medical, legal, financial. Reason codes are `self_harm | medical | legal |
   financial | other` (emergency → `other` with emergency copy). It prefers false positives:
   "health", "loan", "court", "invest" all block. Zodiac "Cancer" only counts as medical with
   medical context words. The worker runs it again, so a question queued under an older
   classifier never reaches the LLM.
2. **Classifier blocks are free.** The contract says blocked questions are refunded; for blocks
   decided before the charge we do not charge at all. Charging and refunding in the same request
   would add two ledger transactions with no effect, would hand back promo money as a *new* lot
   with a fresh expiry (a way to extend promo credit), and would make a person in crisis with an
   empty wallet see "recharge" instead of help. Those questions have `price_paise: 0`,
   `refunded: false`. Questions blocked *after* charging (worker re-check, invalid answers) are
   refunded with `wallet.refund_purchase` (`refund:ai:{id}`).
3. **Exactly-once settlement** (`ai_api.settle`): the question row is locked, only a `queued`
   question can be settled, and refunds use the idempotent ledger key. Re-running the handler or
   `on_failed` changes nothing. If the question row is gone (its kundli was deleted), the
   handler refunds from the ids in the job payload.
4. **Facts** (`astro_api.ai_facts`): the worker calls the engine for the saved kundli
   (`POST /v1/kundli`, `POST /v1/dasha`, `GET /v1/transits`, birth details only in POST bodies)
   and keeps placements and periods only: no birth date, time or place reaches the LLM. With an
   unknown birth time the ascendant, houses and the Vimshottari dasha are omitted (the dasha
   depends on the Moon's exact degree; noon charts would give a wrong period), and the Moon's
   nakshatra/sign are dropped or given as possibilities when they changed that day. Transits are
   optional (left out if that call fails); the kundli and dasha calls are required.
5. **Answer rules**: `ai_safety.output_errors` = the horoscope banned list
   (`horoscope_rules.BANNED`) plus AI rules: no human or astrologer impersonation ("as your
   astrologer", "I am an astrologer", "in my experience"), no certainty ("definitely",
   "guaranteed", "पक्का"), no fear, no remedies/gemstones/mantras/donations/purchases, no
   advice words, no links/phone numbers/emails, 20–250 words, answer language = question
   language. Grounding (`ai_facts.answer_grounding_errors`) reuses
   `horoscope_rules.grounding_errors` on a view of the facts (natal houses from the ascendant and
   transit houses from the Moon are both accepted for a planet; house signs are listed under
   non-planet ids), and adds two checks: a planet named next to "dasha" must be the current or
   next period lord, and any year must be one of the facts' dates.
6. **Language** follows the question: Devanagari-majority or Hinglish (≥ 2 marker words) → Hindi
   in Devanagari; otherwise English.
7. **Labelling**: every decided question stores the fixed AI label (same text as
   `packages/shared` `AI_LABEL`, test-enforced) and a hand-off line ("talk to a human
   astrologer"). `answer` itself is stored plain of both; the UI shows them. Blocked and failed
   questions carry a fixed `notice` (product copy, never user content).
8. **Privacy**: question and answer are AES-256-GCM ciphertext (chat key set, ADR-0007) with AAD
   `ai-question:{id}:{text|answer}`; job payloads are `{question_id, user_id}`; logs carry ids,
   reason codes and counts only. Providers are the horoscope ones (`LLM_PROVIDER`; paid
   no-training tiers; fake refused in staging/production) with a new `answer` method returning
   `{"answer": str}` structured output.

## Consequences

- Prompt changes bump `PROMPT_VERSION` (`ai-answer-v1`), stored per question.
- The regex classifier will block some harmless questions (by design) and can miss paraphrases;
  Phase 7 should add an evaluated classifier and verified crisis helplines (none are shown now;
  the copy says to contact a mental-health professional or local emergency services).
- Grounding is lexical: it checks named planets, signs, English house ordinals, dasha lords and
  years; it does not check nakshatras or Hindi house words.
- All copy (notices, hand-off, Hindi) needs editorial and native-speaker review before launch.
- Price, Hinglish→Hindi answers and the "classifier blocks are free" rule are founder decisions to
  confirm.
