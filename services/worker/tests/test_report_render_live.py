"""Print a tiny local HTML page with the real headless Chromium (the same runner and flags the
report_render job uses). Skips when no Chromium is installed (CHROMIUM_PATH, `chromium`,
`chromium-browser` or /opt/pw-browsers/chromium*/chrome-linux/chrome)."""

import asyncio
from pathlib import Path

import pytest

from astro_api.config import Settings
from astro_worker.handlers import reports as handlers

HTML = """<!doctype html><html lang="hi"><head><meta charset="utf-8"><title>t</title>
<style>@page { size: A4; margin: 12mm } .p { break-after: page }</style></head>
<body><div class="p">Page one: कुंडली</div><div>Page two</div></body></html>"""


def test_real_chromium_prints_a_valid_two_page_pdf(tmp_path: Path) -> None:
    settings = Settings(app_env="test")
    if handlers.find_chromium(settings) is None:
        pytest.skip("no Chromium found")
    page = tmp_path / "page.html"
    page.write_text(HTML, encoding="utf-8")
    out = tmp_path / "out.pdf"
    run = handlers.make_chromium_runner(settings)

    async def go() -> None:
        await run(page.as_uri(), out, 60.0)

    asyncio.run(go())
    data = out.read_bytes()
    assert handlers.validate_pdf(data) == 2
    assert b"/Type /Pages" in data or b"/Type/Pages" in data
