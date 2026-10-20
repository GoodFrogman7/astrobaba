"""Golden fixtures: the engine against independent references (PLAN.md §5 Phase 1 hard gate).

References live in evals/astro/reference/, fetched by scripts/fetch_reference.py from JPL Horizons
and the US Naval Observatory with provenance. Expected values are derived from those raw series
here, with code independent of the engine:

  - planets: Horizons apparent ecliptic-of-date longitude vs engine tropical longitude
  - ascendant: Skyfield sidereal time + true obliquity vs engine ascendant (tropical)
  - sunrise/sunset: USNO (minute precision) vs engine
  - Rahu Kaal: weekday part of the USNO day vs engine
  - tithi / nakshatra transitions: solved from Horizons Sun and Moon series vs engine
    (nakshatra uses the engine's Lahiri ayanamsha; it validates the Moon, not the ayanamsha)

A missing reference file fails the suite: regressions must block merges, not skip.
"""

import json
import math
from datetime import UTC, date, datetime, time, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import pytest
import yaml

from astro_engine.ephemeris import get_backend
from astro_engine.kundli import compute_kundli
from astro_engine.panchang import compute_panchang
from astro_engine.timeutil import jd_from_utc, resolve_local

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
REFERENCE = HERE / "reference"

CHARTS = yaml.safe_load((FIXTURES / "charts.yaml").read_text(encoding="utf-8"))
ALMANAC = yaml.safe_load((FIXTURES / "almanac.yaml").read_text(encoding="utf-8"))
TOL = CHARTS["tolerances"]
SUNRISE_TOL_S = 60
TRANSITION_TOL_S = 120
RAHU_KAAL_TOL_S = 60
BODIES = ("sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn")


@cache
def reference(name: str) -> dict[str, Any]:
    path = REFERENCE / name
    if not path.exists():
        pytest.fail(f"{path} missing: run the 'Golden reference data' workflow", pytrace=False)
    data: dict[str, Any] = json.loads(path.read_text())
    return data


def arcsec(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0) * 3600.0


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def utc_from_jd(jd: float) -> datetime:
    return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(days=jd - 2440587.5)


# ---------------------------------------------------------------- charts

TIMED = [c for c in CHARTS["charts"] if c.get("utc")]


def _engine_chart(c: dict[str, Any]) -> dict[str, Any]:
    local = datetime.fromisoformat(c["local"])
    when = resolve_local(local.date(), local.time(), c["place"]["tz"], utc_offset=c["utc_offset"])
    assert when.utc == ts(c["utc"]), "fixture utc must equal local + offset"
    return compute_kundli(get_backend(), when, c["place"]["lat"], c["place"]["lon"])


@pytest.mark.parametrize("chart", TIMED, ids=lambda c: c["id"])
def test_planet_longitudes_match_jpl_horizons(chart: dict[str, Any]) -> None:
    ref = reference("charts.json")["charts"][chart["id"]]
    k = _engine_chart(chart)
    engine = {g["id"]: g for g in k["grahas"]}
    worst = {
        b: arcsec(engine[b]["tropical_longitude"], ref[b]["tropical_longitude"]) for b in BODIES
    }
    assert max(worst.values()) <= TOL["tropical_longitude_arcsec"], worst
    # Sidereal values (and the nakshatra/pada read from them) follow, with the engine's ayanamsha.
    ayan = k["settings"]["ayanamsha_deg"]
    for b in BODIES:
        sid = (ref[b]["tropical_longitude"] - ayan) % 360.0
        assert arcsec(sid, engine[b]["longitude"]) <= TOL["sidereal_longitude_arcmin"] * 60


def _skyfield_ascendant(utc: datetime, lat: float, lon: float) -> float:
    """Tropical ascendant from Skyfield's apparent sidereal time and true obliquity."""
    from skyfield.api import load

    t = load.timescale(builtin=True).from_datetime(utc)
    ramc = math.radians((t.gast * 15.0 + lon) % 360.0)
    _dpsi, deps = t._nutation_angles_radians
    eps = t._mean_obliquity_radians + deps
    phi = math.radians(lat)
    asc = math.degrees(
        math.atan2(
            math.cos(ramc), -(math.sin(ramc) * math.cos(eps) + math.tan(phi) * math.sin(eps))
        )
    )
    return asc % 360.0


@pytest.mark.parametrize("chart", TIMED, ids=lambda c: c["id"])
def test_ascendant_matches_independent_computation(chart: dict[str, Any]) -> None:
    k = _engine_chart(chart)
    engine_tropical = (k["ascendant"]["longitude"] + k["settings"]["ayanamsha_deg"]) % 360.0
    expected = _skyfield_ascendant(ts(chart["utc"]), chart["place"]["lat"], chart["place"]["lon"])
    assert arcsec(engine_tropical, expected) <= TOL["ascendant_arcmin"] * 60


def test_unknown_time_chart() -> None:
    c = next(x for x in CHARTS["charts"] if x["id"] == "C13")
    when = resolve_local(date.fromisoformat(c["local_date"]), None, c["place"]["tz"])
    k = compute_kundli(get_backend(), when, c["place"]["lat"], c["place"]["lon"])
    assert k["ascendant"] is c["expected"]["ascendant"] is None
    assert k["houses"] is c["expected"]["houses"] is None
    assert k["flags"] == c["expected"]["flags"]


@pytest.mark.parametrize("bad", CHARTS["invalid_inputs"], ids=lambda c: c["id"])
def test_invalid_inputs_rejected(bad: dict[str, Any]) -> None:
    from astro_engine.timeutil import TimeInputError

    local = datetime.fromisoformat(bad["local"])
    with pytest.raises(TimeInputError) as e:
        resolve_local(local.date(), local.time(), bad["place"]["tz"])
    assert f"error_{e.value.code}" == bad["expect"]


# ---------------------------------------------------------------- almanac

ROWS = ALMANAC["rows"]


def _usno_utc(day: date, hhmm: str, tz_hours: float) -> datetime:
    h, m = map(int, hhmm.split(":"))
    local = datetime.combine(day, time(h, m), tzinfo=UTC)
    return local - timedelta(hours=tz_hours)


def _crossings(series: list[tuple[float, float]], span: float) -> list[float]:
    """JDs where an angle series (jd, degrees) crosses multiples of `span`, by unwrapping and
    cubic (4-point Lagrange) interpolation between samples."""
    jds = [s[0] for s in series]
    unwrapped = [series[0][1]]
    for _, a in series[1:]:
        prev = unwrapped[-1]
        unwrapped.append(prev + ((a - prev % 360.0 + 180.0) % 360.0 - 180.0))
    out = []
    for i in range(1, len(series) - 2):
        k0, k1 = math.floor(unwrapped[i] / span), math.floor(unwrapped[i + 1] / span)
        if k1 == k0:
            continue
        target = k1 * span
        xs, ys = jds[i - 1 : i + 3], unwrapped[i - 1 : i + 3]

        def f(
            x: float, xs: list[float] = xs, ys: list[float] = ys, target: float = target
        ) -> float:
            total = 0.0
            for j in range(4):
                term = ys[j]
                for m in range(4):
                    if m != j:
                        term *= (x - xs[m]) / (xs[j] - xs[m])
                total += term
            return total - target

        lo, hi = jds[i], jds[i + 1]
        for _ in range(60):
            mid = (lo + hi) / 2
            if f(lo) * f(mid) <= 0:
                hi = mid
            else:
                lo = mid
        out.append((lo + hi) / 2)
    return out


def _series(row_ref: dict[str, Any], fn: Any) -> list[tuple[float, float]]:
    sun = row_ref["horizons"]["sun"]
    moon = row_ref["horizons"]["moon"]
    assert [s["jd_ut"] for s in sun] == [m["jd_ut"] for m in moon]
    return [(s["jd_ut"], fn(s, m)) for s, m in zip(sun, moon, strict=True)]


def _engine_panchang(row: dict[str, Any]) -> dict[str, Any]:
    place = ALMANAC["places"][row["place"]]
    return compute_panchang(
        get_backend(), date.fromisoformat(row["date"]), place["lat"], place["lon"], place["tz"]
    )


def _boundaries(items: list[dict[str, Any]], lo: float, hi: float) -> list[datetime]:
    stamps = sorted({ts(i["start"]) for i in items} | {ts(i["end"]) for i in items})
    return [s for s in stamps if lo < jd_from_utc(s) < hi]


@pytest.mark.parametrize("row", ROWS, ids=lambda r: r["id"])
def test_sunrise_sunset_and_rahu_kaal_match_usno(row: dict[str, Any]) -> None:
    ref = reference("almanac.json")["rows"][row["id"]]
    p = _engine_panchang(row)
    day = date.fromisoformat(row["date"])
    rise = _usno_utc(day, ref["usno"]["rise_local"], ref["usno"]["tz_hours"])
    sset = _usno_utc(day, ref["usno"]["set_local"], ref["usno"]["tz_hours"])
    assert abs((ts(p["sunrise"]) - rise).total_seconds()) <= SUNRISE_TOL_S, (p["sunrise"], rise)
    assert abs((ts(p["sunset"]) - sset).total_seconds()) <= SUNRISE_TOL_S, (p["sunset"], sset)
    part = (sset - rise) / 8
    rk = rise + (p["rahu_kaal"]["part"] - 1) * part
    assert abs((ts(p["rahu_kaal"]["start"]) - rk).total_seconds()) <= RAHU_KAAL_TOL_S
    assert p["vaara"]["iso"] == day.isoweekday()


@pytest.mark.parametrize("row", ROWS, ids=lambda r: r["id"])
def test_tithi_and_nakshatra_transitions_match_horizons(row: dict[str, Any]) -> None:
    ref = reference("almanac.json")["rows"][row["id"]]
    p = _engine_panchang(row)
    elong = _series(ref, lambda s, m: (m["lon"] - s["lon"]) % 360.0)
    backend = get_backend()
    moon_sid = _series(
        ref, lambda s, m: (m["lon"] - backend.ayanamsha(s["jd_ut"], "lahiri")) % 360.0
    )
    lo, hi = elong[1][0], elong[-2][0]
    for name, items, series, span in (
        ("tithi", p["tithis"], elong, 12.0),
        ("nakshatra", p["nakshatras"], moon_sid, 360.0 / 27),
    ):
        expected = [utc_from_jd(j) for j in _crossings(series, span)]
        for b in _boundaries(items, lo, hi):
            gap = min(abs((e - b).total_seconds()) for e in expected)
            assert gap <= TRANSITION_TOL_S, (name, b, gap)


def test_rows_cover_every_weekday_and_at_least_30_dates() -> None:
    assert len(ROWS) >= 30
    assert {date.fromisoformat(r["date"]).isoweekday() for r in ROWS} == set(range(1, 8))
    assert len(TIMED) >= 10
