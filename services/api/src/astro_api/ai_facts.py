"""Chart facts for AI answers (ADR-0010). Every value comes from the astro engine over HTTP
(PLAN.md §0.4): the saved kundli's chart, its current Vimshottari periods and today's transits.
The LLM sees only these facts and the question; answers are checked against them.

Facts never contain birth details (date, time, place): only placements and periods, so they can
be shown to an LLM provider without identifying anyone. Birth details travel only in POST bodies
to the engine and are never logged.

When the birth time is unknown the engine charts noon: the ascendant, houses and the Vimshottari
dasha (which depends on the Moon's exact degree) are then omitted rather than guessed, and the
Moon's sign/nakshatra are given as uncertain when they changed during that day.
"""

import datetime as dt
import json
import re
from dataclasses import dataclass
from functools import cache
from typing import Any

import httpx

from astro_api import horoscope_rules
from astro_api.models import SavedKundli
from astro_api.shared_files import data_dir

FACTS_VERSION = "ai-facts-v1"


class FactsUnavailable(Exception):
    """The engine could not be reached or refused the chart (a short code, never content)."""


@dataclass(frozen=True)
class BirthInput:
    date: dt.date
    time: dt.time | None
    lat: float
    lon: float
    tz: str
    utc_offset: str | None = None

    @classmethod
    def from_kundli(cls, k: SavedKundli) -> "BirthInput":
        return cls(k.birth_date, k.birth_time, k.lat, k.lon, k.tz, k.utc_offset)

    def engine_body(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "date": self.date.isoformat(),
            "time": self.time.isoformat() if self.time is not None else None,
            "place": {"lat": self.lat, "lon": self.lon, "tz": self.tz},
        }
        # The offset resolved when the kundli was saved (keeps a chosen DST fold). With an
        # unknown time the engine's own noon resolution is used.
        if self.time is not None and self.utc_offset:
            body["utc_offset"] = self.utc_offset
        return body


@cache
def _sign_ids() -> list[str]:
    rows = json.loads((data_dir() / "signs.json").read_text(encoding="utf-8"))["signs"]
    return [r["id"] for r in rows]


def _day(iso: str) -> str:
    return iso[:10]


def _parse(iso: str) -> dt.datetime:
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _current_dasha(dasha: dict[str, Any]) -> dict[str, Any] | None:
    current = dasha.get("current") or {}
    as_of = _parse(current["as_of"]) if current.get("as_of") else None
    mahas = dasha.get("mahadashas") or []
    for i, maha in enumerate(mahas):
        if maha["lord"] != current.get("mahadasha"):
            continue
        if as_of is not None and not _parse(maha["start"]) <= as_of < _parse(maha["end"]):
            continue
        antar = next(
            (
                a
                for a in maha.get("antardashas") or []
                if a["lord"] == current.get("antardasha")
                and (as_of is None or _parse(a["start"]) <= as_of < _parse(a["end"]))
            ),
            None,
        )
        nxt = mahas[i + 1] if i + 1 < len(mahas) else None
        return {
            "system": dasha.get("system", "vimshottari"),
            "as_of": _day(current["as_of"]) if current.get("as_of") else None,
            "mahadasha": maha["lord"],
            "mahadasha_start": _day(maha["start"]),
            "mahadasha_end": _day(maha["end"]),
            "antardasha": antar["lord"] if antar else None,
            "antardasha_start": _day(antar["start"]) if antar else None,
            "antardasha_end": _day(antar["end"]) if antar else None,
            "next_mahadasha": nxt["lord"] if nxt else None,
            "next_mahadasha_start": _day(nxt["start"]) if nxt else None,
        }
    return None


def build_facts(
    kundli: dict[str, Any], dasha: dict[str, Any] | None, transits: dict[str, Any] | None
) -> dict[str, Any]:
    """Pure: engine responses -> the facts an answer may use."""
    birth = kundli.get("birth") or {}
    known = not birth.get("unknown_time", False)
    moon_range = kundli.get("moon_range") or {}
    moon_sign_uncertain = bool(moon_range.get("sign_changes"))
    moon_nak_uncertain = bool(moon_range.get("nakshatra_changes"))
    omitted: list[str] = []

    planets = []
    for g in kundli["grahas"]:
        uncertain_nak = g["id"] == "moon" and (moon_nak_uncertain or moon_sign_uncertain)
        planets.append(
            {
                "graha": g["id"],
                "sign": g["sign"],
                "house": g.get("house") if known else None,
                "nakshatra": None if uncertain_nak else g.get("nakshatra"),
                "pada": None if uncertain_nak else g.get("pada"),
                "retrograde": bool(g.get("retrograde")),
            }
        )
    moon = next(g for g in kundli["grahas"] if g["id"] == "moon")
    possible = [moon["sign"]]
    if moon_sign_uncertain:
        possible = sorted({moon_range["start"]["sign"], moon_range["end"]["sign"]})

    asc = kundli.get("ascendant") if known else None
    ascendant = (
        {"sign": asc["sign"], "nakshatra": asc.get("nakshatra"), "pada": asc.get("pada")}
        if asc
        else None
    )
    houses = None
    if known and kundli.get("houses"):
        signs = _sign_ids()
        houses = [
            {"house": h["house"], "sign": signs[h["sign_index"]], "occupants": h["occupants"]}
            for h in kundli["houses"]
        ]
    if ascendant is None:
        omitted.append("ascendant")
    if houses is None:
        omitted.append("houses")

    current = _current_dasha(dasha) if (dasha and known) else None
    if current is None:
        omitted.append("dasha")

    transit_view = None
    if transits and transits.get("grahas"):
        transit_view = {
            "at": transits.get("at"),
            "planets": [
                {
                    "graha": t["id"],
                    "sign": t["sign"],
                    # Counted from the natal Moon sign; absent when that sign is uncertain.
                    "house_from_moon": None if moon_sign_uncertain else t.get("house_from_moon"),
                    "retrograde": bool(t.get("retrograde")),
                }
                for t in transits["grahas"]
            ],
        }
    else:
        omitted.append("transits")

    settings = kundli.get("settings") or {}
    return {
        "facts_version": FACTS_VERSION,
        "engine_version": settings.get("engine_version"),
        "chart_settings": {
            k: settings.get(k) for k in ("zodiac", "ayanamsha", "node", "house_system")
        },
        "birth_time_known": known,
        "ascendant": ascendant,
        "moon_sign": moon["sign"],
        "moon_sign_possible": possible,
        "planets": planets,
        "houses": houses,
        "dasha": current,
        "transits": transit_view,
        "omitted": omitted,
    }


async def fetch_facts(
    http: httpx.AsyncClient, astro_url: str, birth: BirthInput, now: dt.datetime | None = None
) -> dict[str, Any]:
    """Ask the engine for the chart, the current dasha (known birth time only) and today's
    transits (optional: left out if that call fails). Raises FactsUnavailable."""
    now = now or dt.datetime.now(dt.UTC)
    base = astro_url.rstrip("/")
    body = birth.engine_body()
    try:
        r = await http.post(f"{base}/v1/kundli", json={"birth": body})
        if r.status_code != 200:
            raise FactsUnavailable(f"kundli_{r.status_code}")
        kundli: dict[str, Any] = r.json()
        dasha: dict[str, Any] | None = None
        if birth.time is not None:
            r = await http.post(
                f"{base}/v1/dasha", json={"birth": body, "as_of": now.date().isoformat()}
            )
            if r.status_code != 200:
                raise FactsUnavailable(f"dasha_{r.status_code}")
            dasha = r.json()
    except httpx.HTTPError as exc:
        raise FactsUnavailable(type(exc).__name__) from exc

    transits: dict[str, Any] | None = None
    params: dict[str, Any] = {"at": now.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")}
    moon = next(g for g in kundli["grahas"] if g["id"] == "moon")
    if not (kundli.get("moon_range") or {}).get("sign_changes"):
        params["moon_sign_index"] = moon["sign_index"]
    try:
        r = await http.get(f"{base}/v1/transits", params=params)
        if r.status_code == 200:
            transits = r.json()
    except httpx.HTTPError:
        transits = None
    return build_facts(kundli, dasha, transits)


# ------------------------------------------------------------------ grounding


def grounding_view(facts: dict[str, Any]) -> dict[str, Any]:
    """The facts in the shape astro_api.horoscope_rules.grounding_errors reads: a subject sign
    and a list of {graha, sign, house_from_sign}. Natal houses (from the ascendant) and transit
    houses (from the Moon) are both allowed for a planet; 0 means "no house known". Houses
    themselves are listed under ids that are not planet names, so "your 7th house is Aries" is
    checked against the chart without letting any planet sit there."""
    entries: list[dict[str, Any]] = []
    for p in facts["planets"]:
        signs = facts["moon_sign_possible"] if p["graha"] == "moon" else [p["sign"]]
        for s in signs:
            entries.append({"graha": p["graha"], "sign": s, "house_from_sign": p["house"] or 0})
    for t in (facts.get("transits") or {}).get("planets", []):
        entries.append(
            {"graha": t["graha"], "sign": t["sign"], "house_from_sign": t["house_from_moon"] or 0}
        )
    for h in facts.get("houses") or []:
        entries.append(
            {"graha": f"house:{h['house']}", "sign": h["sign"], "house_from_sign": h["house"]}
        )
    subject = facts["ascendant"]["sign"] if facts.get("ascendant") else facts["moon_sign"]
    return {"sign": subject, "transits": entries}


_SENTENCE = re.compile(r"[^.!?।]+")
_DASHA_WORD = re.compile(r"dasha|dasa|bhukti|दशा", re.IGNORECASE)
_YEAR = re.compile(r"(?<!\d)(1[89]\d\d|2[0-3]\d\d)(?!\d)")


def _fact_years(facts: dict[str, Any]) -> set[str]:
    years = set()
    for value in (facts.get("dasha") or {}).values():
        if isinstance(value, str) and re.match(r"^\d{4}-", value):
            years.add(value[:4])
    at = (facts.get("transits") or {}).get("at")
    if isinstance(at, str):
        years.add(at[:4])
    return years


def answer_grounding_errors(text: str, facts: dict[str, Any]) -> list[str]:
    """Every planet, sign and house named must match the facts (horoscope rules on the Q&A
    view); a planet named next to a dasha must be the current or next period lord; any year
    must be one of the facts' dates."""
    errors = horoscope_rules.grounding_errors(text, grounding_view(facts))
    names = horoscope_rules.names()
    dasha = facts.get("dasha")
    lords = (
        {dasha["mahadasha"], dasha["antardasha"], dasha["next_mahadasha"]} - {None}
        if dasha
        else set()
    )
    for sentence in _SENTENCE.findall(text):
        if _DASHA_WORD.search(sentence):
            if not dasha:
                errors.append("mentions a dasha, which the facts do not give")
                continue
            for g in horoscope_rules._mentions(sentence, names.graha) - lords:
                errors.append(f"names {g} as a dasha lord, which the facts do not")
    years = _fact_years(facts)
    for year in sorted(set(_YEAR.findall(text)) - years):
        errors.append(f"mentions the year {year}, which is not in the facts")
    return errors
