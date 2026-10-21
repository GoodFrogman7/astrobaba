import asyncio
from pathlib import Path

import pytest
from pydantic import SecretStr

from astro_api.config import Settings
from astro_api.email import ConsoleEmail, SmtpEmail, make_email_sender, mask_email


def test_console_keeps_mail_and_masks_logs(caplog: pytest.LogCaptureFixture) -> None:
    sender = make_email_sender(Settings(app_env="test"))
    ConsoleEmail.outbox.clear()
    caplog.set_level("INFO")
    asyncio.run(sender.send("asha@example.com", "Your report", "link"))
    assert ConsoleEmail.outbox == [("asha@example.com", "Your report", "link")]
    assert "asha@example.com" not in caplog.text and "a***@example.com" in caplog.text
    assert mask_email("no-at") == "***"


def test_console_refused_in_production_and_smtp_needs_a_url(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError):
        ConsoleEmail(Settings(app_env="production"))
    with pytest.raises(RuntimeError):
        SmtpEmail(Settings(app_env="test", email_provider="smtp", smtp_url=SecretStr("")))
    sender = make_email_sender(
        Settings(
            app_env="test", email_provider="smtp", smtp_url=SecretStr("smtp://u:p@mail.test:587")
        )
    )
    assert isinstance(sender, SmtpEmail)
