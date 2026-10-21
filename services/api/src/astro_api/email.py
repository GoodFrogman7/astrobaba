"""Email for report links and partner leads. Bodies may hold personal data (a lead's phone for
the partner), so nothing here logs a body or a full address."""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import ClassVar, Protocol
from urllib.parse import unquote, urlparse

import anyio

from astro_api.config import Settings

log = logging.getLogger("astro_api.email")


def mask_email(address: str) -> str:
    name, _, domain = address.partition("@")
    return f"{name[:1]}***@{domain}" if domain else "***"


class EmailSender(Protocol):
    async def send(self, to: str, subject: str, body: str) -> None: ...


class ConsoleEmail:
    """Development and tests only: keeps messages in `outbox`, logs the masked recipient."""

    outbox: ClassVar[list[tuple[str, str, str]]] = []

    def __init__(self, settings: Settings) -> None:
        if settings.is_production:
            raise RuntimeError("console email provider is not allowed in staging/production")

    async def send(self, to: str, subject: str, body: str) -> None:
        ConsoleEmail.outbox.append((to, subject, body))
        log.info("email (console) to %s: %s", mask_email(to), subject)


class SmtpEmail:
    def __init__(self, settings: Settings) -> None:
        url = urlparse(settings.smtp_url.get_secret_value())
        if url.scheme not in ("smtp", "smtps") or not url.hostname:
            raise RuntimeError("SMTP_URL must be smtp(s)://user:password@host:port")
        self.url = url
        self.sender = settings.email_from

    def _send(self, message: EmailMessage) -> None:
        u = self.url
        context = ssl.create_default_context()
        if u.scheme == "smtps":
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                u.hostname or "", u.port or 465, context=context
            )
        else:
            server = smtplib.SMTP(u.hostname or "", u.port or 587)
            server.starttls(context=context)
        with server:
            if u.username:
                server.login(unquote(u.username), unquote(u.password or ""))
            server.send_message(message)

    async def send(self, to: str, subject: str, body: str) -> None:
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = self.sender, to, subject
        message.set_content(body)
        await anyio.to_thread.run_sync(self._send, message)
        log.info("email sent to %s", mask_email(to))


def make_email_sender(settings: Settings) -> EmailSender:
    return ConsoleEmail(settings) if settings.email_provider == "console" else SmtpEmail(settings)
