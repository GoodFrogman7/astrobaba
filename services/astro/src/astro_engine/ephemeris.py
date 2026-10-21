"""Ephemeris backend (ADR-0001). Endpoint code depends on the EphemerisBackend protocol only,
so the Swiss Ephemeris implementation can be swapped (e.g. for Skyfield + JPL) without changes.

Swiss Ephemeris is AGPL-3.0 here (ADR-0001 option C): only this service may import it.
"""

import threading
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Literal, Protocol

import swisseph as swe

from astro_engine.config import get_settings

Ayanamsha = Literal["lahiri", "raman", "krishnamurti", "true_chitra"]
NodeType = Literal["mean", "true"]
GRAHA_ORDER = ("sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn", "rahu", "ketu")

_AYANAMSHA_MODES: dict[str, int] = {
    "lahiri": swe.SIDM_LAHIRI,
    "raman": swe.SIDM_RAMAN,
    "krishnamurti": swe.SIDM_KRISHNAMURTI,
    "true_chitra": swe.SIDM_TRUE_CITRA,
}
_BODIES: dict[str, int] = {
    "sun": swe.SUN,
    "moon": swe.MOON,
    "mars": swe.MARS,
    "mercury": swe.MERCURY,
    "jupiter": swe.JUPITER,
    "venus": swe.VENUS,
    "saturn": swe.SATURN,
}


class EphemerisError(RuntimeError):
    pass


@dataclass(frozen=True)
class BodyPosition:
    tropical: float  # apparent geocentric ecliptic longitude of date, degrees [0, 360)
    sidereal: float  # tropical minus ayanamsha, degrees [0, 360)
    latitude: float
    speed: float  # degrees per day (negative = retrograde)


class EphemerisBackend(Protocol):
    name: str
    version: str

    def body(
        self, jd_ut: float, graha: str, ayanamsha: Ayanamsha, node: NodeType
    ) -> BodyPosition: ...

    def ascendant(self, jd_ut: float, lat: float, lon: float, ayanamsha: Ayanamsha) -> float: ...

    def ayanamsha(self, jd_ut: float, ayanamsha: Ayanamsha) -> float: ...

    def sunrise(self, jd_ut: float, lat: float, lon: float) -> float | None: ...

    def sunset(self, jd_ut: float, lat: float, lon: float) -> float | None: ...


def norm(angle: float) -> float:
    return angle % 360.0


class _ThreadState(threading.local):
    ephe_path: str | None = None


class SwissEphemeris:
    """pyswisseph wrapper.

    Swiss Ephemeris keeps its settings (file path, sidereal mode) in thread-local storage, and
    FastAPI serves requests from a thread pool. So every call goes through `_ready()`, which sets
    the path once per thread, and sets the sidereal mode right before it is used. The lock covers
    builds of the library without thread-local storage.
    """

    name = "swiss_ephemeris"
    _lock = threading.RLock()
    _thread = _ThreadState()

    def __init__(self, ephe_path: Path, *, allow_moshier: bool) -> None:
        self.allow_moshier = allow_moshier
        self.version = str(swe.version)
        self.ephe_path = str(ephe_path)
        if not allow_moshier and not any(ephe_path.glob("*.se1")):
            raise EphemerisError(
                f"No Swiss Ephemeris files in {ephe_path}. Run `make data` (or set ALLOW_MOSHIER "
                "for throwaway local use only)."
            )

    def _ready(self) -> None:
        if self._thread.ephe_path != self.ephe_path:
            swe.set_ephe_path(self.ephe_path)
            self._thread.ephe_path = self.ephe_path

    def _calc(self, jd_ut: float, body: int, flags: int) -> tuple[float, float, float]:
        flags |= swe.FLG_SWIEPH | swe.FLG_SPEED
        xx, retflag = swe.calc_ut(jd_ut, body, flags)
        if not retflag & swe.FLG_SWIEPH and not self.allow_moshier:
            raise EphemerisError("Swiss Ephemeris fell back to Moshier; ephemeris files missing")
        return xx[0], xx[1], xx[3]

    def body(self, jd_ut: float, graha: str, ayanamsha: Ayanamsha, node: NodeType) -> BodyPosition:
        if graha in ("rahu", "ketu"):
            code = swe.MEAN_NODE if node == "mean" else swe.TRUE_NODE
        else:
            code = _BODIES[graha]
        with self._lock:
            self._ready()
            swe.set_sid_mode(_AYANAMSHA_MODES[ayanamsha])
            trop, lat, speed = self._calc(jd_ut, code, 0)
            sid, _, _ = self._calc(jd_ut, code, swe.FLG_SIDEREAL)
        if graha == "ketu":
            trop, sid, lat = trop + 180.0, sid + 180.0, -lat
        return BodyPosition(norm(trop), norm(sid), lat, speed)

    def ayanamsha(self, jd_ut: float, ayanamsha: Ayanamsha) -> float:
        """Ayanamsha consistent with this backend's sidereal positions (tropical - sidereal)."""
        sun = self.body(jd_ut, "sun", ayanamsha, "mean")
        return norm(sun.tropical - sun.sidereal)

    def ascendant(self, jd_ut: float, lat: float, lon: float, ayanamsha: Ayanamsha) -> float:
        with self._lock:
            self._ready()
            swe.set_sid_mode(_AYANAMSHA_MODES[ayanamsha])
            _, ascmc = swe.houses_ex(jd_ut, lat, lon, b"W", swe.FLG_SIDEREAL)
        return norm(ascmc[0])

    def _rise_set(self, jd_ut: float, lat: float, lon: float, kind: int) -> float | None:
        # Upper limb on the horizon with standard refraction (1013.25 hPa, 15 °C), sea level:
        # the same convention as the US Naval Observatory tables we validate against.
        with self._lock:
            self._ready()
            res, tret = swe.rise_trans(jd_ut, swe.SUN, kind, (lon, lat, 0.0), 1013.25, 15.0)
        return None if res != 0 else float(tret[0])

    def sunrise(self, jd_ut: float, lat: float, lon: float) -> float | None:
        """First sunrise after jd_ut, or None in polar day/night."""
        return self._rise_set(jd_ut, lat, lon, swe.CALC_RISE)

    def sunset(self, jd_ut: float, lat: float, lon: float) -> float | None:
        return self._rise_set(jd_ut, lat, lon, swe.CALC_SET)


@cache
def get_backend() -> EphemerisBackend:
    s = get_settings()
    return SwissEphemeris(s.ephe_path, allow_moshier=s.allow_moshier and not s.is_production)
