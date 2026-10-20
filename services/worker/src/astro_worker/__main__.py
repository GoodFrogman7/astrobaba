"""Worker entry point. Jobs (horoscopes, PDFs, reconciliation, payouts) register here in later
phases; the queue library is chosen with the first real job."""

import sys

JOBS: dict[str, str] = {}


def main(argv: list[str]) -> int:
    if argv[1:] == ["--list"]:
        print("\n".join(sorted(JOBS)) or "no jobs registered")
        return 0
    print("usage: python -m astro_worker --list", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
