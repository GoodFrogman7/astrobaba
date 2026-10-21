"""KYC document storage. Documents are personal data: never public, never logged, read only
through the admin content endpoint."""

import hashlib
import secrets
from pathlib import Path
from typing import Protocol

from astro_api.config import Settings
from astro_api.errors import ApiError
from astro_api.shared_files import repo_data_dir
from astro_api.sms import NotConfiguredError

# Content types are decided from the file's first bytes, never from the client's claim.
MAGIC = (
    (b"%PDF-", "application/pdf"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
)


def sniff_content_type(data: bytes) -> str | None:
    return next((ctype for magic, ctype in MAGIC if data.startswith(magic)), None)


class DocumentStorage(Protocol):
    name: str

    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...


class LocalStorage:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        if "/" in key or ".." in key or not key:
            raise ValueError("invalid storage key")
        return self.root / key

    def put(self, key: str, data: bytes) -> None:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self._path(key)
        path.write_bytes(data)
        path.chmod(0o600)

    def get(self, key: str) -> bytes:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError as exc:
            raise ApiError(404, "document_missing", "The stored file is missing.") from exc

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3Storage:
    """Production backend (S3, ap-south-1, SSE-KMS). Not implemented until the bucket exists."""

    name = "s3"

    def __init__(self) -> None:
        raise NotConfiguredError("S3 document storage is not configured yet")

    def put(self, key: str, data: bytes) -> None:  # pragma: no cover
        raise NotConfiguredError("S3 document storage is not configured yet")

    def get(self, key: str) -> bytes:  # pragma: no cover
        raise NotConfiguredError("S3 document storage is not configured yet")

    def delete(self, key: str) -> None:  # pragma: no cover
        raise NotConfiguredError("S3 document storage is not configured yet")


def make_storage(settings: Settings) -> DocumentStorage:
    if settings.documents_backend == "s3":
        return S3Storage()
    root = settings.documents_dir
    if root is None:
        data = repo_data_dir()
        root = (data / "uploads") if data else Path("/var/lib/astro/uploads")
    return LocalStorage(root)


def new_key() -> str:
    """Random storage key; the uploader's filename is never used as a path."""
    return secrets.token_hex(16)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
