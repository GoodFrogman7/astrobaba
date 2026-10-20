from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.models import AuditLog


def audit(
    session: AsyncSession,
    actor: str,
    action: str,
    entity: str,
    entity_id: str | None,
    **detail: Any,
) -> None:
    """Record an action in the caller's transaction. Detail must not hold personal data."""
    session.add(
        AuditLog(actor=actor, action=action, entity=entity, entity_id=entity_id, detail=detail)
    )
