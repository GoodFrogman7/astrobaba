"""AES-256-GCM for chat messages at rest: AAD binding, key rotation, dev key derivation."""

import base64
import os
import uuid

import pytest
from cryptography.exceptions import InvalidTag
from pydantic import SecretStr

from astro_api.chat_crypto import (
    DEV_KEY_ID,
    MessageCipher,
    Sealed,
    UnknownKey,
    aad,
    cipher_from_settings,
)
from astro_api.config import Settings

SID = uuid.UUID("5f1c7a52-3f0e-4d0b-9e57-0a4c1c1f2b3d")


def b64(key: bytes) -> str:
    return base64.b64encode(key).decode()


def settings(**values: object) -> Settings:
    return Settings(app_env="test", secret_key=SecretStr("x" * 40), **values)  # type: ignore[arg-type]


def test_round_trip_and_aad_binding() -> None:
    cipher = MessageCipher({"k1": os.urandom(32)}, "k1")
    sealed = cipher.encrypt("namaste 🙏", aad(SID, 7))
    assert sealed.key_id == "k1" and len(sealed.nonce) == 12
    assert b"namaste" not in sealed.ciphertext
    assert cipher.decrypt(sealed, aad(SID, 7)) == "namaste 🙏"
    # Moved to another position or session: authentication fails.
    with pytest.raises(InvalidTag):
        cipher.decrypt(sealed, aad(SID, 8))
    with pytest.raises(InvalidTag):
        cipher.decrypt(sealed, aad(uuid.uuid4(), 7))
    # Fresh nonce every time.
    assert cipher.encrypt("same", b"a").nonce != cipher.encrypt("same", b"a").nonce


def test_key_rotation_keeps_old_rows_readable() -> None:
    old, new = os.urandom(32), os.urandom(32)
    before = cipher_from_settings(settings(messages_key=SecretStr(b64(old)), messages_key_id="k1"))
    row = before.encrypt("old message", aad(SID, 1))
    rotated = cipher_from_settings(settings(messages_key=SecretStr(f"k2:{b64(new)},k1:{b64(old)}")))
    assert rotated.current == "k2" and set(rotated.key_ids) == {"k1", "k2"}
    assert rotated.decrypt(row, aad(SID, 1)) == "old message"
    assert rotated.encrypt("new", aad(SID, 2)).key_id == "k2"
    retired = cipher_from_settings(settings(messages_key=SecretStr(f"k2:{b64(new)}")))
    with pytest.raises(UnknownKey):
        retired.decrypt(Sealed(row.ciphertext, row.nonce, "k1"), aad(SID, 1))


def test_dev_key_only_outside_production() -> None:
    dev = cipher_from_settings(settings())
    assert dev.current == DEV_KEY_ID
    again = cipher_from_settings(settings())
    sealed = dev.encrypt("hello", b"x")
    assert again.decrypt(sealed, b"x") == "hello"  # deterministic from SECRET_KEY
    other = cipher_from_settings(Settings(app_env="test", secret_key=SecretStr("y" * 40)))
    with pytest.raises(InvalidTag):
        other.decrypt(sealed, b"x")
    with pytest.raises(RuntimeError):
        cipher_from_settings(Settings(app_env="production", secret_key=SecretStr("z" * 40)))


@pytest.mark.parametrize(
    "value", ["not base64!", b64(os.urandom(16)), "k1:", f"k1:{b64(os.urandom(31))}"]
)
def test_bad_keys_are_refused(value: str) -> None:
    with pytest.raises(ValueError):
        cipher_from_settings(settings(messages_key=SecretStr(value)))
