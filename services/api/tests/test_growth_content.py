"""Content calendar items (docs/api/growth.md §4.1): validation, filters, order, audit."""

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from astro_api import growth_api as g
from astro_api.errors import ApiError

ITEMS = "/v1/admin/content-items"


def actions(client: TestClient) -> list[tuple[str, str]]:
    async def run() -> list[tuple[str, str]]:
        url = client.app.state.settings.database_url.get_secret_value()  # type: ignore[attr-defined]
        eng = create_async_engine(url)
        try:
            async with eng.begin() as conn:
                rows = await conn.execute(
                    text("SELECT action, entity_id FROM audit_log ORDER BY id")
                )
                return [(r[0], r[1]) for r in rows]
        finally:
            await eng.dispose()

    return asyncio.run(run())


@pytest.mark.parametrize(
    "url",
    ["/learn/what-is-a-kundli", "/hi/panchang?x=1", "https://www.youtube.com/watch?v=abc"],
)
def test_valid_urls(url: str) -> None:
    assert g.clean_url(url) == url
    assert g.clean_url(f"  {url} ") == url


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/x",
        "//evil.example.com/x",
        "javascript:alert(1)",
        "learn/x",
        "https://",
        "https:///path",
        "/learn/a b",
        "ftp://example.com",
        "https://exa mple.com",
    ],
)
def test_invalid_urls(url: str) -> None:
    with pytest.raises(ApiError) as exc:
        g.clean_url(url)
    assert exc.value.code == "invalid_url"


def test_blank_url_is_none() -> None:
    assert g.clean_url("  ") is None and g.clean_url(None) is None


@pytest.mark.integration
def test_crud_filters_and_audit(
    client: TestClient, admin_headers: dict[str, str], login: Any
) -> None:
    def post(**body: Any) -> Any:
        return client.post(ITEMS, json=body, headers=admin_headers)

    r = post(title="  Kundli basics  ", kind="article", locale="both", due_date="2026-11-05")
    assert r.status_code == 201, r.text
    first = r.json()
    assert set(first) == {
        "id",
        "title",
        "kind",
        "locale",
        "status",
        "due_date",
        "url",
        "notes",
        "created_at",
        "updated_at",
    }
    assert (first["title"], first["status"], first["url"], first["notes"]) == (
        "Kundli basics",
        "idea",
        None,
        None,
    )
    second = post(title="Reel: Ekadashi", kind="social", locale="hi", due_date="2026-11-01").json()
    undated = post(title="Someday", kind="video", locale="en").json()
    published = post(
        title="Panchang page",
        kind="tool_page",
        locale="en",
        status="published",
        url="/panchang",
        due_date="2026-10-30",
    )
    assert published.status_code == 201, published.text

    # Validation.
    bad = [
        ({"title": "", "kind": "article", "locale": "en"}, 422),
        ({"title": "   ", "kind": "article", "locale": "en"}, 422),
        ({"title": "x" * 161, "kind": "article", "locale": "en"}, 422),
        ({"title": "ok", "kind": "podcast", "locale": "en"}, 422),
        ({"title": "ok", "kind": "article", "locale": "ta"}, 422),
        ({"title": "ok", "kind": "article", "locale": "en", "notes": "n" * 1001}, 422),
        ({"title": "ok", "kind": "article", "locale": "en", "url": "http://x.com"}, 422),
        ({"title": "ok", "kind": "article", "locale": "en", "status": "published"}, 422),
    ]
    for body, status in bad:
        assert post(**body).status_code == status, body
    r = post(title="ok", kind="article", locale="en", status="published")
    assert r.json()["detail"]["code"] == "url_required"

    # Order: due_date, then created_at; undated last.
    items = client.get(ITEMS, headers=admin_headers).json()["items"]
    assert [i["title"] for i in items] == [
        "Panchang page",
        "Reel: Ekadashi",
        "Kundli basics",
        "Someday",
    ]
    q = {"from": "2026-11-01", "to": "2026-11-30"}
    assert [
        i["id"] for i in client.get(ITEMS, params=q, headers=admin_headers).json()["items"]
    ] == [second["id"], first["id"]]
    by_status = client.get(ITEMS, params={"status": "published"}, headers=admin_headers).json()
    assert [i["title"] for i in by_status["items"]] == ["Panchang page"]
    by_kind = client.get(ITEMS, params={"kind": "video"}, headers=admin_headers).json()
    assert [i["id"] for i in by_kind["items"]] == [undated["id"]]

    # PATCH: publishing needs a URL (already set or in the same request); nulls clear optionals.
    path = f"{ITEMS}/{first['id']}"
    r = client.patch(path, json={"status": "published"}, headers=admin_headers)
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "url_required")
    r = client.patch(
        path,
        json={"status": "published", "url": "/learn/kundli-basics", "notes": "SEO brief"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["url"], r.json()["notes"]) == (
        "published",
        "/learn/kundli-basics",
        "SEO brief",
    )
    assert r.json()["updated_at"] >= first["updated_at"]
    r = client.patch(path, json={"url": None}, headers=admin_headers)
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "url_required")
    r = client.patch(
        path, json={"status": "review", "url": None, "due_date": None}, headers=admin_headers
    )
    assert r.status_code == 200 and (r.json()["url"], r.json()["due_date"]) == (None, None)
    assert client.patch(path, json={"title": None}, headers=admin_headers).status_code == 422
    assert client.patch(path, json={"kind": "nope"}, headers=admin_headers).status_code == 422

    assert client.delete(path, headers=admin_headers).status_code == 204
    assert client.delete(path, headers=admin_headers).status_code == 404
    assert client.patch(path, json={"title": "x"}, headers=admin_headers).status_code == 404

    logged = actions(client)
    assert logged.count(("content_item.create", first["id"])) == 1
    assert logged.count(("content_item.update", first["id"])) == 2
    assert logged.count(("content_item.delete", first["id"])) == 1
    assert len([a for a in logged if a[0] == "content_item.create"]) == 4

    user = login("+919877770001")
    assert client.get(ITEMS, headers=user).status_code == 403
    assert (
        client.post(
            ITEMS, json={"title": "x", "kind": "other", "locale": "en"}, headers=user
        ).status_code
        == 403
    )
    assert client.delete(f"{ITEMS}/{second['id']}", headers=user).status_code == 403
