"""Shared pieces: environment guards, tags, and the local state directory.

Everything the seed creates is tagged so `clean` can find it without the local state file:
users have phones starting with PHONE_PREFIX (+91 then a leading 0: never a real Indian mobile,
and distinct from astro_api.seed's +9100000 prefix so the demo seed never touches them);
astrologers also have `is_seed = true` (shown as `is_demo`) and slugs starting with SLUG_PREFIX.
"""

import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
PHONE_PREFIX = "+91000019"  # then 1 = client, 2 = astrologer, 9 = tests; then 6 digits
CLIENT_SLOT, ASTROLOGER_SLOT = "1", "2"
SLUG_PREFIX = "loadtest-"
CREDIT_CAMPAIGN = "loadtest"
STATE_FILE = "state.json"


class Refused(RuntimeError):
    """The tool will not run here (environment or location)."""


def ensure_seed_allowed(app_env: str) -> None:
    """Seeding and cleaning write straight to the database: development and test only."""
    if app_env not in ("development", "test"):
        raise Refused(f"seed/clean run only with APP_ENV development or test (got {app_env!r})")


def ensure_run_allowed(app_env: str) -> None:
    """The run drives the public API; it is refused in production (docs/api/growth.md §6)."""
    if app_env == "production":
        raise Refused("the load test is refused when APP_ENV is production")


def outside_repo(path: Path) -> Path:
    """Tokens and reports never go into the repository."""
    resolved = path.resolve()
    if resolved == REPO_ROOT or REPO_ROOT in resolved.parents:
        raise Refused(f"state directory must be outside the repository: {resolved}")
    return resolved


def state_dir() -> Path:
    """LOADTEST_DIR, default <system temp>/astro-loadtest. Created with mode 0700."""
    raw = os.environ.get("LOADTEST_DIR") or str(Path(tempfile.gettempdir()) / "astro-loadtest")
    path = outside_repo(Path(raw))
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(stat.S_IRWXU)
    return path


def write_private_json(path: Path, data: Any) -> None:
    """Write JSON readable only by the owner (the state file holds bearer tokens)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    tmp.replace(path)


def read_state() -> dict[str, Any]:
    path = state_dir() / STATE_FILE
    if not path.exists():
        raise Refused(f"no seed state at {path}; run `python -m loadtest seed` first")
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data
