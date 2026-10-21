"""In-memory place search over data/build/cities.tsv.gz (GeoNames, CC-BY 4.0).

Prefix search on names and alternate spellings (Latin and Devanagari), ranked by exact match
then population. Built once at startup; ~150k places.
"""

import bisect
import csv
import gzip
import unicodedata
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from astro_engine.config import get_settings

ATTRIBUTION = "Place data © GeoNames (https://www.geonames.org), CC-BY 4.0"


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.strip().casefold())
    if not any("ऀ" <= c <= "ॿ" for c in text):
        text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", " ".join(text.replace("-", " ").split()))


@dataclass(frozen=True)
class City:
    id: int
    name: str
    country: str
    country_name: str
    admin1_name: str
    lat: float
    lon: float
    tz: str
    population: int

    def as_dict(self) -> dict[str, Any]:
        label = ", ".join(p for p in (self.name, self.admin1_name, self.country_name) if p)
        return {
            "id": self.id,
            "name": self.name,
            "label": label,
            "admin1": self.admin1_name or None,
            "country": self.country,
            "country_name": self.country_name,
            "lat": self.lat,
            "lon": self.lon,
            "tz": self.tz,
            "population": self.population,
        }


class CityIndex:
    def __init__(self, path: Path) -> None:
        self.cities: dict[int, City] = {}
        pairs: list[tuple[str, int]] = []
        with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
            self.source = f.readline().lstrip("# ").strip()
            for row in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\"):
                city = City(
                    id=int(row["id"]),
                    name=row["name"],
                    country=row["country"],
                    country_name=row["country_name"],
                    admin1_name=row["admin1_name"],
                    lat=float(row["lat"]),
                    lon=float(row["lon"]),
                    tz=row["tz"],
                    population=int(row["population"]),
                )
                self.cities[city.id] = city
                names = {row["name"], row["ascii"], *filter(None, row["alt"].split("|"))}
                pairs.extend((normalize(n), city.id) for n in names if n)
        pairs.sort()
        self._keys = [k for k, _ in pairs]
        self._ids = [i for _, i in pairs]

    def search(self, query: str, limit: int = 10, country: str | None = None) -> list[City]:
        q = normalize(query)
        if not q:
            return []
        lo = bisect.bisect_left(self._keys, q)
        hi = bisect.bisect_left(self._keys, q + "\U0010ffff")
        exact: set[int] = set()
        found: set[int] = set()
        for key, cid in zip(self._keys[lo:hi], self._ids[lo:hi], strict=True):
            found.add(cid)
            if key == q:
                exact.add(cid)
        matches = [self.cities[c] for c in found]
        if country:
            matches = [c for c in matches if c.country == country.upper()]
        matches.sort(key=lambda c: (c.id not in exact, -c.population, c.name))
        return matches[:limit]

    def get(self, city_id: int) -> City | None:
        return self.cities.get(city_id)


@cache
def get_city_index() -> CityIndex:
    path = get_settings().cities_file
    if not path.exists():
        raise FileNotFoundError(f"{path} missing; run `make data`")
    return CityIndex(path)
