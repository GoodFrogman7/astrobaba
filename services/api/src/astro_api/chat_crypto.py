"""Chat messages at rest: AES-256-GCM (ADR-0007).

Each message gets a random 96-bit nonce and AAD `{session_id}:{seq}`, so a ciphertext cannot be
moved to another session or position without failing authentication. The key id is stored per
row, which is what makes rotation possible:

- `MESSAGES_KEY` is either one base64 32-byte key (its id is `MESSAGES_KEY_ID`), or a
  comma-separated list `id:base64,id:base64,...` whose FIRST entry encrypts new messages and
  whose other entries still decrypt older rows. Rotate by prepending a new key; a re-encryption
  job can later rewrite old rows and retire the old key.
- In development/test, when `MESSAGES_KEY` is empty, a key is derived from `SECRET_KEY` with
  HKDF-SHA256 (key id `dev`). That is for local work only; production refuses to start without
  `MESSAGES_KEY` (config.check_production_settings).
"""

import base64
import binascii
import logging
import os
import uuid
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from astro_api.config import Settings

log = logging.getLogger("astro_api.chat")

DEV_KEY_ID = "dev"


class UnknownKey(Exception):
    """A row names a key id this process does not have."""


def aad(session_id: uuid.UUID, seq: int) -> bytes:
    return f"{session_id}:{seq}".encode()


@dataclass(frozen=True)
class Sealed:
    ciphertext: bytes
    nonce: bytes
    key_id: str


class MessageCipher:
    def __init__(self, keys: dict[str, bytes], current: str) -> None:
        if current not in keys:
            raise ValueError("current key id missing from the key set")
        for key in keys.values():
            if len(key) != 32:
                raise ValueError("chat message keys must be 32 bytes (AES-256)")
        self._aead = {kid: AESGCM(key) for kid, key in keys.items()}
        self.current = current

    @property
    def key_ids(self) -> tuple[str, ...]:
        return tuple(self._aead)

    def encrypt(self, plaintext: str, associated: bytes) -> Sealed:
        nonce = os.urandom(12)
        ct = self._aead[self.current].encrypt(nonce, plaintext.encode(), associated)
        return Sealed(ct, nonce, self.current)

    def decrypt(self, sealed: Sealed, associated: bytes) -> str:
        aead = self._aead.get(sealed.key_id)
        if aead is None:
            raise UnknownKey(sealed.key_id)
        return aead.decrypt(sealed.nonce, sealed.ciphertext, associated).decode()


def _b64key(raw: str) -> bytes:
    try:
        key = base64.b64decode(raw.strip(), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("MESSAGES_KEY is not valid base64") from exc
    if len(key) != 32:
        raise ValueError("MESSAGES_KEY must decode to 32 bytes")
    return key


def dev_key(secret_key: str) -> bytes:
    return HKDF(
        algorithm=hashes.SHA256(), length=32, salt=b"astro-chat-dev", info=b"messages-key"
    ).derive(secret_key.encode())


def cipher_from_settings(settings: Settings) -> MessageCipher:
    raw = settings.messages_key.get_secret_value().strip()
    if not raw:
        if settings.is_production:
            raise RuntimeError("MESSAGES_KEY missing")
        log.warning("chat messages use a key derived from SECRET_KEY (development/test only)")
        return MessageCipher(
            {DEV_KEY_ID: dev_key(settings.secret_key.get_secret_value())}, DEV_KEY_ID
        )
    if ":" not in raw:
        return MessageCipher({settings.messages_key_id: _b64key(raw)}, settings.messages_key_id)
    keys: dict[str, bytes] = {}
    current = ""
    for part in raw.split(","):
        kid, _, value = part.strip().partition(":")
        if not kid or not value:
            raise ValueError("MESSAGES_KEY list entries look like id:base64")
        keys[kid] = _b64key(value)
        current = current or kid
    return MessageCipher(keys, current)
