"""Record real astro engine responses for the AI assistant tests (PLAN.md §0.4: never typed by
hand). Runs the engine in-process at a fixed instant, so the output is reproducible:

    uv run python services/api/tests/fixtures/record_ai_engine.py

Writes ai_engine_known_time.json and ai_engine_unknown_time.json next to this file. The birth is
the fictional sample chart from data/marketplace/products.json (no real person's data).
"""

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from astro_engine.main import app

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
AS_OF = "2026-10-21"
AT = "2026-10-21T06:00:00Z"


def record(client: TestClient, birth: dict[str, Any]) -> dict[str, Any]:
    kundli = client.post("/v1/kundli", json={"birth": birth})
    kundli.raise_for_status()
    dasha = client.post("/v1/dasha", json={"birth": birth, "as_of": AS_OF})
    dasha.raise_for_status()
    k = kundli.json()
    moon = next(g for g in k["grahas"] if g["id"] == "moon")
    params: dict[str, Any] = {"at": AT}
    if not (k.get("moon_range") or {}).get("sign_changes"):
        params["moon_sign_index"] = moon["sign_index"]
    transits = client.get("/v1/transits", params=params)
    transits.raise_for_status()
    return {
        "recorded_with": {"as_of": AS_OF, "at": AT, "birth": birth},
        "kundli": k,
        "dasha": dasha.json(),
        "transits": transits.json(),
    }


def main() -> None:
    sample = json.loads((REPO / "data/marketplace/products.json").read_text())["sample_birth"]
    with TestClient(app) as client:
        found = client.get("/v1/cities", params={"q": "New Delhi", "country": "IN", "limit": 1})
        found.raise_for_status()
        city = found.json()["results"][0]
        place = {"lat": city["lat"], "lon": city["lon"], "tz": city["tz"]}
        known = {"date": sample["date"], "time": sample["time"], "place": place}
        unknown = {"date": sample["date"], "time": None, "place": place}
        for name, birth in (("known_time", known), ("unknown_time", unknown)):
            out = HERE / f"ai_engine_{name}.json"
            out.write_text(
                json.dumps(record(client, birth), indent=1, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            print(f"wrote {out}")


if __name__ == "__main__":
    main()
