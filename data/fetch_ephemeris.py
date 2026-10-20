"""Download the Swiss Ephemeris data files (1800-2399 CE) into data/raw/ephe, verifying SHA-256.

The files are AGPL-3.0 like the library (ADR-0001). Source: github.com/aloistr/swisseph.
Usage: uv run python data/fetch_ephemeris.py [--dest DIR]
"""

import argparse
import hashlib
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/aloistr/swisseph/master/ephe/"
FILES = {
    "sepl_18.se1": "ca1393ceab3a44fbc895887cf789c68819ae6a1cbc9b22225872dbe4ccd99a66",
    "semo_18.se1": "1ca07bd67c24374d77226180c20a4f9996cba013697894810518e7eb582ca4f7",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", type=Path, default=Path(__file__).resolve().parent / "raw" / "ephe")
    args = ap.parse_args()
    args.dest.mkdir(parents=True, exist_ok=True)
    for name, sha in FILES.items():
        path = args.dest / name
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == sha:
            print(f"ok {name}")
            continue
        with urllib.request.urlopen(BASE + name, timeout=60) as resp:  # noqa: S310 - fixed host
            data = resp.read()
        digest = hashlib.sha256(data).hexdigest()
        if digest != sha:
            raise SystemExit(f"checksum mismatch for {name}: {digest}")
        path.write_bytes(data)
        print(f"downloaded {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
