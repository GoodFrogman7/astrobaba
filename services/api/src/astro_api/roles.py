"""Role checks on top of OTP sessions. Admins are users with the `admin` role."""

from typing import Annotated

from fastapi import Depends

from astro_api.auth import CurrentUser
from astro_api.errors import ApiError
from astro_api.models import User

ROLES = ("admin",)


async def require_admin(user: CurrentUser) -> User:
    if "admin" not in (user.roles or []):
        raise ApiError(403, "forbidden", "Admin access required.")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


def actor(user: User) -> str:
    """Audit-log actor: a stable id, never a phone number."""
    return f"user:{user.id}"
