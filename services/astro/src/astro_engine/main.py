"""Astro engine service. Phase 0 is a skeleton; calculations land in Phase 1 (PLAN.md §5)."""

from fastapi import FastAPI

from astro_engine import __version__

app = FastAPI(title="AstroPlatform astro engine", version=__version__, redoc_url=None)


@app.get("/healthz", tags=["ops"])
async def healthz() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.get("/v1/meta", tags=["meta"])
async def meta() -> dict[str, object]:
    """What the engine computes with. Calculation endpoints return 501 until Phase 1."""
    return {
        "version": __version__,
        "ephemeris_backend": None,  # decided in docs/adr/0001-ephemeris-licensing.md
        "default_ayanamsha": "lahiri",
        "time_contract": "instants in UTC plus an IANA zone; format at the edge",
    }
