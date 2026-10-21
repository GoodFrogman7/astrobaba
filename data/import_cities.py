"""Build data/build/cities.tsv.gz, the place-search index for the astro engine.

Sources (GeoNames, CC-BY 4.0, attribution required):
  --source geonames  download cities1000.zip + admin1CodesASCII.txt from download.geonames.org
                     (adds state/province names; preferred for production images)
  --source bundled   use the GeoNames extract bundled in the `geonamescache` package (no network,
                     no state names)
  --source auto      try geonames, fall back to bundled (default)

Usage: uv run python data/import_cities.py [--source auto] [--min-population 1000]
"""

import argparse
import csv
import gzip
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "build" / "cities.tsv.gz"
GEONAMES = "https://download.geonames.org/export/dump/"
COLUMNS = [
    "id",
    "name",
    "ascii",
    "country",
    "country_name",
    "admin1",
    "admin1_name",
    "lat",
    "lon",
    "tz",
    "population",
    "alt",
]


def _alts(names: list[str], country: str) -> str:
    """Alternate names kept for search: Devanagari everywhere (Hindi users), Latin spellings only
    for South Asia, where transliterations vary most (Banaras/Benares/Varanasi)."""
    names = [n for n in names if n and len(n) <= 60 and "|" not in n and "\t" not in n]
    deva = [n for n in names if any("\u0900" <= c <= "\u097f" for c in n)][:4]
    latin = [n for n in names if n.isascii()][:8] if country in ("IN", "NP", "LK", "BD") else []
    return "|".join(deva + latin)


def _rows_bundled(min_pop: int) -> tuple[list[list[str]], str]:
    import geonamescache

    gc = geonamescache.GeonamesCache(
        min_city_population=min_pop if min_pop in (500, 1000, 5000, 15000) else 1000
    )
    countries = {c: v["name"] for c, v in gc.get_countries().items()}
    rows = []
    for c in gc.get_cities().values():
        if c["population"] < min_pop:
            continue
        alts = _alts(c.get("alternatenames", []), c["countrycode"])
        rows.append(
            [
                str(c["geonameid"]),
                c["name"],
                c["name"],
                c["countrycode"],
                countries.get(c["countrycode"], c["countrycode"]),
                c.get("admin1code", ""),
                "",
                f"{c['latitude']:.5f}",
                f"{c['longitude']:.5f}",
                c["timezone"],
                str(c["population"]),
                alts,
            ]
        )
    return rows, "geonamescache " + getattr(geonamescache, "__version__", "")


def _fetch(name: str) -> bytes:
    with urllib.request.urlopen(GEONAMES + name, timeout=60) as resp:  # noqa: S310 - fixed host
        data: bytes = resp.read()
    return data


def _rows_geonames(min_pop: int) -> tuple[list[list[str]], str]:
    admin1 = {}
    for line in _fetch("admin1CodesASCII.txt").decode("utf-8").splitlines():
        code, name, *_ = line.split("\t")
        admin1[code] = name
    countries = {}
    for line in _fetch("countryInfo.txt").decode("utf-8").splitlines():
        if line and not line.startswith("#"):
            parts = line.split("\t")
            countries[parts[0]] = parts[4]
    z = zipfile.ZipFile(io.BytesIO(_fetch("cities1000.zip")))
    rows = []
    with z.open("cities1000.txt") as f:
        for line in io.TextIOWrapper(f, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            pop = int(p[14] or 0)
            if pop < min_pop:
                continue
            alts = _alts(p[3].split(","), p[8])
            rows.append(
                [
                    p[0],
                    p[1],
                    p[2],
                    p[8],
                    countries.get(p[8], p[8]),
                    p[10],
                    admin1.get(f"{p[8]}.{p[10]}", ""),
                    f"{float(p[4]):.5f}",
                    f"{float(p[5]):.5f}",
                    p[17],
                    str(pop),
                    alts,
                ]
            )
    return rows, "download.geonames.org"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["auto", "geonames", "bundled"], default="auto")
    ap.add_argument("--min-population", type=int, default=1000)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    rows: list[list[str]] = []
    origin = ""
    if args.source in ("auto", "geonames"):
        try:
            rows, origin = _rows_geonames(args.min_population)
        except OSError as exc:
            if args.source == "geonames":
                raise
            print(f"GeoNames download failed ({exc}); using bundled extract", file=sys.stderr)
    if not rows:
        rows, origin = _rows_bundled(args.min_population)

    rows.sort(key=lambda r: -int(r[10]))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.out, "wt", encoding="utf-8", newline="") as f:
        f.write(f"# source: {origin}; GeoNames (https://www.geonames.org), CC-BY 4.0\n")
        w = csv.writer(
            f, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar="\\"
        )
        w.writerow(COLUMNS)
        w.writerows(rows)
    print(f"wrote {len(rows)} cities to {args.out} (source: {origin})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
