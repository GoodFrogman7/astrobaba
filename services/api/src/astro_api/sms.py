"""SMS delivery for OTP codes. Codes are never logged except by the console provider, which is
for development and tests only and refuses to run in staging/production."""

import logging
from typing import ClassVar, Protocol

from astro_api.config import Settings
from astro_api.phone import mask_phone

log = logging.getLogger("astro_api.sms")


class NotConfiguredError(RuntimeError):
    pass


class SmsSender(Protocol):
    name: str

    async def send_otp(self, phone: str, code: str) -> None: ...


class ConsoleSms:
    """Logs the code instead of sending it. `outbox` lets tests read codes without parsing logs."""

    name = "console"
    outbox: ClassVar[list[tuple[str, str]]] = []

    def __init__(self, settings: Settings) -> None:
        if settings.is_production:
            raise NotConfiguredError("console SMS provider is not allowed in staging/production")

    async def send_otp(self, phone: str, code: str) -> None:
        ConsoleSms.outbox.append((phone, code))
        # The masked phone goes through the logger; the code is only shown in development.
        log.warning("OTP for %s: %s", mask_phone(phone), code)


class Msg91Sms:
    """Placeholder until an SMS provider account (DLT template, sender ID, auth key) exists."""

    name = "msg91"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def send_otp(self, phone: str, code: str) -> None:
        raise NotConfiguredError("MSG91 is not configured yet: add credentials and implement")


def make_sms_sender(settings: Settings) -> SmsSender:
    if settings.sms_provider == "console":
        return ConsoleSms(settings)
    return Msg91Sms(settings)
