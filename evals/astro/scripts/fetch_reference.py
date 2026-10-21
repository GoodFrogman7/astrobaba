"""Fetch independent reference data for the golden fixtures and store it with provenance.

Sources (both US government works, public domain):
  - JPL Horizons API: apparent geocentric ecliptic-of-date longitudes (observer quantity 31)
      * each chart's Sun..Saturn at the birth instant
      * Sun and Moon every 10 minutes across each almanac row's day (for tithi and nakshatra
        transition times, solved later by the test harness)
  - US Naval Observatory API: sunrise and sunset per almanac row

Nothing here is typed by hand or produced by the engine under test. Run where those hosts are
reachable (GitHub Actions: .github/workflows/reference-data.yml):

  uv run python evals/astro/scripts/fetch_reference.py
"""

import json
import sys
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from time import sleep
from typing import Any
from zoneinfo import ZoneInfo

import yaml

HERE = Path(__file__).resolve().parents[1]
OUT = HERE / "reference"
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
USNO = "https://aa.usno.navy.mil/api/rstt/oneday"
BODIES = {
    "sun": "10",
    "moon": "301",
    "mercury": "199",
    "venus": "299",
    "mars": "499",
    "jupiter": "599",
    "saturn": "699",
}
UA = {"User-Agent": "astroplatform-golden-fixtures/1 (reference data for tests)"}


def _get(url: str, params: dict[str, str], retries: int = 4) -> Any:
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full, headers=UA)  # noqa: S310 - fixed hosts
            with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
                return json.loads(resp.read().decode("utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            if attempt == retries - 1:
                raise RuntimeError(f"{url} failed: {exc}") from exc
            sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def _q(value: str) -> str:
    return f"'{value}'"


def horizons(body: str, extra: dict[str, str]) -> list[dict[str, Any]]:
    """Rows of (jd_ut, lon, lat) from an observer table with quantity 31."""
    params = {
        "format": "json",
        "COMMAND": _q(BODIES[body]),
        "OBJ_DATA": _q("NO"),
        "MAKE_EPHEM": _q("YES"),
        "EPHEM_TYPE": _q("OBSERVER"),
        "CENTER": _q("500@399"),
        "QUANTITIES": _q("31"),
        "TIME_TYPE": _q("UT"),
        "CAL_FORMAT": _q("JD"),
        "ANG_FORMAT": _q("DEG"),
        "CSV_FORMAT": _q("YES"),
        "EXTRA_PREC": _q("YES"),
        **{k: _q(v) for k, v in extra.items()},
    }
    data = _get(HORIZONS, params)
    if "error" in data:
        raise RuntimeError(f"Horizons error for {body}: {data['error']}")
    text: str = data["result"]
    lines = text.splitlines()
    soe = lines.index("$$SOE")
    eoe = lines.index("$$EOE")
    header = next(line for line in reversed(lines[:soe]) if "ObsEcLon" in line)
    cols = [c.strip() for c in header.split(",")]
    i_jd = next(i for i, c in enumerate(cols) if "JDUT" in c or "JD" in c)
    i_lon, i_lat = cols.index("ObsEcLon"), cols.index("ObsEcLat")
    rows = []
    for line in lines[soe + 1 : eoe]:
        parts = [p.strip() for p in line.split(",")]
        rows.append(
            {"jd_ut": float(parts[i_jd]), "lon": float(parts[i_lon]), "lat": float(parts[i_lat])}
        )
    sleep(1)  # be polite to JPL
    return rows


def jd(instant: datetime) -> float:
    return instant.timestamp() / 86400.0 + 2440587.5


def fetch_charts() -> dict[str, Any]:
    charts = yaml.safe_load((HERE / "fixtures" / "charts.yaml").read_text(encoding="utf-8"))[
        "charts"
    ]
    timed = [c for c in charts if c.get("utc")]
    jds = {c["id"]: jd(datetime.fromisoformat(c["utc"])) for c in timed}
    tlist = " ".join(f"{v:.9f}" for v in jds.values())
    out: dict[str, Any] = {c: {} for c in jds}
    for body in BODIES:
        rows = horizons(body, {"TLIST": tlist, "TLIST_TYPE": "JD"})
        for cid, value in jds.items():
            row = min(rows, key=lambda r: abs(r["jd_ut"] - value))
            if abs(row["jd_ut"] - value) > 1e-6:
                raise RuntimeError(f"Horizons returned no row for {cid} {body}")
            out[cid][body] = {
                "tropical_longitude": row["lon"],
                "latitude": row["lat"],
                "jd_ut": row["jd_ut"],
            }
    return out


def fetch_almanac() -> dict[str, Any]:
    spec = yaml.safe_load((HERE / "fixtures" / "almanac.yaml").read_text(encoding="utf-8"))
    places = spec["places"]
    out: dict[str, Any] = {}
    for row in spec["rows"]:
        place = places[row["place"]]
        day = date.fromisoformat(row["date"])
        zi = ZoneInfo(place["tz"])
        midnight = datetime.combine(day, time(), tzinfo=zi).astimezone(UTC)
        noon_offset = datetime.combine(day, time(12), tzinfo=zi).utcoffset()
        assert noon_offset is not None
        tz_hours = noon_offset.total_seconds() / 3600

        usno = _get(
            USNO,
            {
                "date": day.isoformat(),
                "coords": f"{place['lat']},{place['lon']}",
                "tz": f"{tz_hours:g}",
                "dst": "false",
            },
        )
        sundata = {d["phen"]: d["time"][:5] for d in usno["properties"]["data"]["sundata"]}
        start, stop = midnight - timedelta(hours=2), midnight + timedelta(hours=36)
        window = {
            "START_TIME": f"JD{jd(start):.6f}",
            "STOP_TIME": f"JD{jd(stop):.6f}",
            "STEP_SIZE": "10 m",
        }
        out[row["id"]] = {
            "date": row["date"],
            "place": place,
            "usno": {
                "tz_hours": tz_hours,
                "rise_local": sundata.get("Rise"),
                "set_local": sundata.get("Set"),
            },
            "horizons": {b: horizons(b, window) for b in ("sun", "moon")},
        }
        sleep(1)
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    provenance = {
        "retrieved_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "horizons": HORIZONS
        + " (observer table, CENTER=500@399, QUANTITIES=31 apparent ecliptic-of-date)",
        "usno": USNO + " (sunrise/sunset: upper limb, standard refraction; minute precision)",
        "script": "evals/astro/scripts/fetch_reference.py",
    }
    charts = fetch_charts()
    (OUT / "charts.json").write_text(
        json.dumps({"provenance": provenance, "charts": charts}, indent=1) + "\n"
    )
    almanac = fetch_almanac()
    (OUT / "almanac.json").write_text(
        json.dumps({"provenance": provenance, "rows": almanac}, indent=1) + "\n"
    )
    print(f"wrote {len(charts)} charts and {len(almanac)} almanac rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
