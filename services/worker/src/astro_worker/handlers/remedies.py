"""Job handlers: remedy_lead_notify (docs/api/revenue.md §4).

Sends a lead to its partner by email (the console provider in development) with the remedy, the
preferred date, the language, the user's phone and the decrypted note, then marks the lead
notified. Idempotent: a lead already notified is skipped, and the row stays locked while sending
so two workers cannot both send it. The phone and the note appear only in the email body, never
in logs or job errors.
"""

import datetime as dt
import logging
import uuid
from typing import Any

from sqlalchemy import select

from astro_api import remedies_api
from astro_api.chat_crypto import Sealed, cipher_from_settings
from astro_api.email import ConsoleEmail, EmailSender, make_email_sender
from astro_api.models_remedies import RemedyLead, note_aad
from astro_worker.jobs import Context, JobError, register

log = logging.getLogger("astro_worker.remedies")

LANGUAGE_NAMES = {"en": "English", "hi": "Hindi"}


def sender_for(ctx: Context, channel: str) -> EmailSender:
    if channel == "console":
        # Refuses to start in staging/production (dev-only partners never reach here there).
        return ConsoleEmail(ctx.settings)
    if channel == "email":
        return make_email_sender(ctx.settings)
    raise JobError("partner_channel_unsupported")


def lead_email(lead: RemedyLead, note: str | None) -> tuple[str, str]:
    name = remedies_api.remedy_name(lead.remedy_id) or {"en": lead.remedy_id, "hi": ""}
    subject = f"New enquiry: {name['en']} (lead {str(lead.id)[:8]})"
    lines = [
        "A user asked to be contacted about one of your services.",
        "",
        f"Service: {name['en']}" + (f" / {name['hi']}" if name.get("hi") else ""),
        f"Service id: {lead.remedy_id}",
        f"Lead id: {lead.id}",
        "Preferred date: "
        + (lead.preferred_date.isoformat() if lead.preferred_date else "no preference"),
        f"Language: {LANGUAGE_NAMES.get(lead.language, lead.language)}",
        f"Phone: {lead.phone}",
        f"Note from the user: {note if note else '(none)'}",
        "",
        "The user agreed to share this phone number with you for this enquiry only. Please share",
        "the price before booking, do not promise outcomes, and do not use it for marketing.",
    ]
    return subject, "\n".join(lines)


async def notify_lead(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    lead_id = uuid.UUID(str(payload["lead_id"]))
    async with ctx.sessionmaker() as db:
        lead = (
            await db.execute(select(RemedyLead).where(RemedyLead.id == lead_id).with_for_update())
        ).scalar_one_or_none()
        if lead is None or lead.notified_at is not None or lead.status == "spam":
            return  # deleted (account erased), already sent, or marked spam before sending
        partner = remedies_api.partner(lead.partner_id, ctx.settings)
        if partner is None:
            raise JobError("partner_unavailable")
        contact = partner.get("contact") or {}
        address = contact.get("address")
        if not address:
            raise JobError("partner_contact_missing")
        sender = sender_for(ctx, str(contact.get("channel", "")))
        note = None
        if lead.note_ciphertext is not None:
            assert lead.note_nonce is not None and lead.note_key_id is not None
            cipher = cipher_from_settings(ctx.settings)
            note = cipher.decrypt(
                Sealed(lead.note_ciphertext, lead.note_nonce, lead.note_key_id), note_aad(lead.id)
            )
        subject, body = lead_email(lead, note)
        try:
            await sender.send(str(address), subject, body)
        except Exception as exc:  # the provider's message may echo the body; keep only a code
            raise JobError("email_failed") from exc
        lead.notified_at = dt.datetime.now(dt.UTC)
        await db.commit()
    log.info("remedy_lead_notified", extra={"lead_id": str(lead_id)})


async def notify_failed(ctx: Context, job_id: uuid.UUID, payload: dict[str, Any]) -> None:
    # Ids only. The admin leads list shows the lead as not yet sent to the partner.
    log.error(
        "remedy_lead_notify_failed",
        extra={"job_id": str(job_id), "lead_id": str(payload.get("lead_id"))},
    )


register("remedy_lead_notify", notify_lead, notify_failed)
