"""Job handlers. Importing this package registers every handler with astro_worker.jobs."""

from astro_worker.handlers import ai, remedies, reports  # noqa: F401
from astro_worker.handlers import privacy as _privacy  # noqa: F401
