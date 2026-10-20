# Test fixtures

`facts_aries_daily.json` is real astro engine output, not hand-typed (PLAN.md §0.4). Regenerate:

```sh
uv run python -c "import json; from fastapi.testclient import TestClient; from astro_engine.main import app; \
print(json.dumps(TestClient(app).get('/v1/horoscope/facts', params={'sign':'aries','period':'daily','date':'2026-10-22'}).json(), indent=1, ensure_ascii=False))"
```
