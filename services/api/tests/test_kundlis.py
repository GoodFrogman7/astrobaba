from typing import Any

import pytest
from fastapi.testclient import TestClient

from astro_api.sms import ConsoleSms

pytestmark = pytest.mark.integration

BIRTH = {
    "date": "1990-12-31",
    "time": "23:59",
    "place": {
        "lat": 12.9716,
        "lon": 77.5946,
        "tz": "Asia/Kolkata",
        "label": "Bengaluru",
        "city_id": 1277333,
    },
}


def token_for(client: TestClient, phone: str) -> dict[str, str]:
    r = client.post("/v1/auth/otp/request", json={"phone": phone, "device_id": f"device-{phone}"})
    assert r.status_code == 202, r.text
    v = client.post(
        "/v1/auth/otp/verify",
        json={
            "challenge_id": r.json()["challenge_id"],
            "code": ConsoleSms.outbox[-1][1],
            "device_id": f"device-{phone}",
        },
    )
    return {"Authorization": f"Bearer {v.json()['token']}"}


def test_requires_auth(client: TestClient) -> None:
    assert client.get("/v1/kundlis").status_code == 401
    assert client.post("/v1/kundlis", json={"name": "A", "birth": BIRTH}).status_code == 401


def test_create_list_get_delete(client: TestClient) -> None:
    h = token_for(client, "9876500011")
    r = client.post(
        "/v1/kundlis", json={"name": " Asha ", "gender": "female", "birth": BIRTH}, headers=h
    )
    assert r.status_code == 201, r.text
    k = r.json()
    assert k["name"] == "Asha"
    assert k["birth_datetime_utc"].startswith("1990-12-31T18:29:00")
    assert k["utc_offset_used"] == "+05:30" and k["unknown_time"] is False
    assert [x["id"] for x in client.get("/v1/kundlis", headers=h).json()] == [k["id"]]
    assert (
        client.get(f"/v1/kundlis/{k['id']}", headers=h).json()["birth"]["place"]["label"]
        == "Bengaluru"
    )
    assert client.delete(f"/v1/kundlis/{k['id']}", headers=h).status_code == 204
    assert client.get(f"/v1/kundlis/{k['id']}", headers=h).status_code == 404


def test_unknown_time_and_offset_override(client: TestClient) -> None:
    h = token_for(client, "9876500012")
    no_time = {**BIRTH, "time": None}
    r = client.post("/v1/kundlis", json={"name": "B", "birth": no_time}, headers=h).json()
    assert r["unknown_time"] is True and r["birth_datetime_utc"].startswith("1990-12-31T06:30:00")
    wartime = {**BIRTH, "date": "1943-05-10", "time": "10:00", "utc_offset": "+05:53"}
    r = client.post("/v1/kundlis", json={"name": "C", "birth": wartime}, headers=h).json()
    assert r["utc_offset_used"] == "+05:53" and r["birth_datetime_utc"].startswith(
        "1943-05-10T04:07:00"
    )


@pytest.mark.parametrize(
    ("birth", "code"),
    [
        (
            {
                "date": "2024-03-31",
                "time": "01:30",
                "place": {"lat": 51.5, "lon": -0.12, "tz": "Europe/London"},
            },
            "nonexistent_local_time",
        ),
        (
            {
                "date": "2024-11-03",
                "time": "01:30",
                "place": {"lat": 40.7, "lon": -74.0, "tz": "America/New_York"},
            },
            "ambiguous_local_time",
        ),
        (
            {
                "date": "1750-01-01",
                "time": "01:30",
                "place": {"lat": 28.6, "lon": 77.2, "tz": "Asia/Kolkata"},
            },
            "date_out_of_range",
        ),
        (
            {
                "date": "2000-01-01",
                "time": "01:30",
                "place": {"lat": 28.6, "lon": 77.2, "tz": "Mars/Olympus"},
            },
            "unknown_time_zone",
        ),
    ],
)
def test_invalid_local_times_rejected_like_the_engine(
    client: TestClient, birth: dict[str, Any], code: str
) -> None:
    h = token_for(client, "9876500013")
    r = client.post("/v1/kundlis", json={"name": "D", "birth": birth}, headers=h)
    assert r.status_code == 422 and r.json()["detail"]["code"] == code


def test_ambiguous_time_accepted_with_fold(client: TestClient) -> None:
    h = token_for(client, "9876500014")
    birth = {
        "date": "2024-11-03",
        "time": "01:30",
        "fold": 1,
        "place": {"lat": 40.7, "lon": -74.0, "tz": "America/New_York"},
    }
    r = client.post("/v1/kundlis", json={"name": "E", "birth": birth}, headers=h)
    assert r.status_code == 201 and r.json()["utc_offset_used"] == "-05:00"


def test_users_cannot_see_each_others_kundlis(client: TestClient) -> None:
    a, b = token_for(client, "9876500021"), token_for(client, "9876500022")
    k = client.post("/v1/kundlis", json={"name": "Mine", "birth": BIRTH}, headers=a).json()
    assert client.get("/v1/kundlis", headers=b).json() == []
    assert client.get(f"/v1/kundlis/{k['id']}", headers=b).status_code == 404
    assert client.delete(f"/v1/kundlis/{k['id']}", headers=b).status_code == 404
    assert client.get(f"/v1/kundlis/{k['id']}", headers=a).status_code == 200


def test_limit_of_twenty(client: TestClient) -> None:
    h = token_for(client, "9876500031")
    for i in range(20):
        assert (
            client.post(
                "/v1/kundlis", json={"name": f"K{i}", "birth": BIRTH}, headers=h
            ).status_code
            == 201
        )
    r = client.post("/v1/kundlis", json={"name": "K21", "birth": BIRTH}, headers=h)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "limit_reached"
