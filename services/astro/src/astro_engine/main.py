"""Astro engine API. Every astro value it returns is computed here from the ephemeris or read
from data/astro tables (PLAN.md §0.4). Instants are UTC ISO-8601 plus an IANA zone.

This service uses Swiss Ephemeris under AGPL-3.0 (ADR-0001); /v1/source links to its source.
"""

from datetime import UTC, date, datetime, time
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from astro_engine import __version__
from astro_engine.cities import ATTRIBUTION, get_city_index
from astro_engine.config import get_settings
from astro_engine.dasha import vimshottari
from astro_engine.doshas import kaal_sarp, mangal_dosha, sade_sati
from astro_engine.ephemeris import Ayanamsha, EphemerisError, NodeType, get_backend
from astro_engine.kundli import compute_kundli
from astro_engine.matching import ashtakoota
from astro_engine.models import (
    MAX_DATE,
    MIN_DATE,
    Birth,
    DashaRequest,
    DoshaRequest,
    KundliRequest,
    MatchRequest,
)
from astro_engine.panchang import compute_panchang
from astro_engine.tables import get_tables
from astro_engine.timeutil import TimeInputError, resolve_local
from astro_engine.transits import compute_transits

SOURCE_URL = "https://github.com/GoodFrogman7/astrobaba/tree/main/services/astro"

app = FastAPI(title="AstroPlatform astro engine", version=__version__, redoc_url=None)


@app.exception_handler(TimeInputError)
async def time_input_error(_: Request, exc: TimeInputError) -> JSONResponse:
    return JSONResponse({"detail": {"code": exc.code, "message": str(exc)}}, status_code=422)


@app.exception_handler(EphemerisError)
async def ephemeris_error(_: Request, exc: EphemerisError) -> JSONResponse:
    return JSONResponse(
        {"detail": {"code": "ephemeris_unavailable", "message": str(exc)}}, status_code=503
    )


def _resolve(b: Birth) -> Any:
    return resolve_local(b.date, b.time, b.place.tz, utc_offset=b.utc_offset, fold=b.fold)


def _kundli(b: Birth, ayanamsha: Ayanamsha, node: NodeType = "mean") -> dict[str, Any]:
    return compute_kundli(get_backend(), _resolve(b), b.place.lat, b.place.lon, ayanamsha, node)


def _moon(chart: dict[str, Any]) -> dict[str, Any]:
    return next(g for g in chart["grahas"] if g["id"] == "moon")


def _as_of(day: date | None) -> datetime:
    return datetime.combine(day, time(12, 0), tzinfo=UTC) if day else datetime.now(UTC)


def _require_reviewed(table: str) -> None:
    status = get_tables().review_status()
    if get_settings().reviewed_tables_required and (
        status[table] != "verified" or status["nakshatra_attributes"] != "verified"
    ):
        raise HTTPException(
            503,
            {
                "code": "tables_not_reviewed",
                "message": f"The {table} tables await astrologer sign-off.",
            },
        )


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.get("/v1/meta", tags=["meta"])
def meta() -> dict[str, Any]:
    backend = get_backend()
    return {
        "version": __version__,
        "ephemeris_backend": backend.name,
        "ephemeris_version": backend.version,
        "default_ayanamsha": "lahiri",
        "default_node": "mean",
        "house_system": "whole_sign",
        "time_contract": "instants in UTC plus an IANA zone; format at the edge",
        "tables_review_status": get_tables().review_status(),
        "source": SOURCE_URL,
        "license": "AGPL-3.0-only",
    }


@app.get("/v1/source", tags=["meta"])
def source() -> dict[str, str]:
    """AGPL-3.0 §13: users interacting with this service over a network can get its source."""
    return {"source": SOURCE_URL, "license": "AGPL-3.0-only"}


@app.get("/v1/cities", tags=["places"])
def cities(
    q: Annotated[str, Query(min_length=2, max_length=60)],
    limit: Annotated[int, Query(ge=1, le=25)] = 10,
    country: Annotated[str | None, Query(pattern=r"^[A-Za-z]{2}$")] = None,
) -> dict[str, Any]:
    index = get_city_index()
    return {
        "results": [c.as_dict() for c in index.search(q, limit, country)],
        "attribution": ATTRIBUTION,
    }


@app.get("/v1/cities/{city_id}", tags=["places"])
def city(city_id: int) -> dict[str, Any]:
    found = get_city_index().get(city_id)
    if found is None:
        raise HTTPException(404, {"code": "city_not_found"})
    return {**found.as_dict(), "attribution": ATTRIBUTION}


@app.post("/v1/kundli", tags=["charts"])
def kundli(req: KundliRequest) -> dict[str, Any]:
    return _kundli(req.birth, req.ayanamsha, req.node)


@app.post("/v1/dasha", tags=["charts"])
def dasha(req: DashaRequest) -> dict[str, Any]:
    when = _resolve(req.birth)
    chart = _kundli(req.birth, req.ayanamsha)
    result = vimshottari(_moon(chart)["longitude"], when.utc, _as_of(req.as_of))
    result["birth"] = chart["birth"]
    result["flags"] = chart["flags"]
    return result


@app.post("/v1/doshas", tags=["charts"])
def doshas(req: DoshaRequest) -> dict[str, Any]:
    _require_reviewed("doshas")
    chart = _kundli(req.birth, req.ayanamsha)
    when = _resolve(req.birth)
    return {
        "birth": chart["birth"],
        "flags": chart["flags"],
        "mangal": mangal_dosha(chart),
        "kaal_sarp": kaal_sarp(chart),
        "sade_sati": sade_sati(
            get_backend(), _moon(chart)["sign_index"], when.utc, _as_of(req.as_of), req.ayanamsha
        ),
        "tables_review_status": get_tables().review_status()["doshas"],
    }


@app.post("/v1/match", tags=["charts"])
def match(req: MatchRequest) -> dict[str, Any]:
    _require_reviewed("matching")
    groom = _kundli(req.groom, req.ayanamsha)
    bride = _kundli(req.bride, req.ayanamsha)
    result = ashtakoota(_moon(groom), _moon(bride))
    result["groom"] = {
        "birth": groom["birth"],
        "moon": _moon(groom),
        "flags": groom["flags"],
        "mangal_dosha": mangal_dosha(groom),
    }
    result["bride"] = {
        "birth": bride["birth"],
        "moon": _moon(bride),
        "flags": bride["flags"],
        "mangal_dosha": mangal_dosha(bride),
    }
    return result


@app.get("/v1/panchang", tags=["almanac"])
def panchang(
    lat: Annotated[float, Query(ge=-90, le=90)],
    lon: Annotated[float, Query(ge=-180, le=180)],
    tz: Annotated[str, Query(min_length=1, max_length=64)],
    date_: Annotated[date, Query(alias="date", ge=MIN_DATE, le=MAX_DATE)],
    ayanamsha: Ayanamsha = "lahiri",
) -> dict[str, Any]:
    return compute_panchang(get_backend(), date_, lat, lon, tz, ayanamsha)


@app.get("/v1/transits", tags=["almanac"])
def transits(
    at: datetime | None = None,
    ayanamsha: Ayanamsha = "lahiri",
    node: NodeType = "mean",
    moon_sign_index: Annotated[int | None, Query(ge=0, le=11)] = None,
) -> dict[str, Any]:
    when = at or datetime.now(UTC)
    if when.tzinfo is None:
        raise HTTPException(
            422, {"code": "naive_datetime", "message": "`at` needs a UTC offset or Z"}
        )
    if not MIN_DATE <= when.astimezone(UTC).date() <= MAX_DATE:
        raise HTTPException(
            422, {"code": "date_out_of_range", "message": "Supported dates: 1800-2399 CE"}
        )
    return compute_transits(get_backend(), when.astimezone(UTC), ayanamsha, node, moon_sign_index)
