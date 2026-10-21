import json

import pytest

from astro_api.flags import all_flags, flag_enabled
from astro_api.shared_files import shared_dir


def test_defaults_match_shared_file() -> None:
    raw = json.loads((shared_dir() / "flags" / "flags.json").read_text())
    assert all_flags({}) == {k: v["default"] for k, v in raw.items()}


def test_env_override() -> None:
    assert flag_enabled("ai_assistant", {"FLAG_AI_ASSISTANT": "1"}) is True
    assert flag_enabled("hindi_locale", {"FLAG_HINDI_LOCALE": "false"}) is False
    assert flag_enabled("hindi_locale", {"FLAG_HINDI_LOCALE": "maybe"}) is True


def test_unknown_flag_raises() -> None:
    with pytest.raises(KeyError):
        flag_enabled("nope", {})
