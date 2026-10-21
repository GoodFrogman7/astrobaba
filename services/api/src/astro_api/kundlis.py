"""Saved kundlis for signed-in users. Birth details are personal data: never logged."""

import datetime as dt
import uuid
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from astro_api.auth import CurrentUser
from astro_api.db import Db
from astro_api.errors import ApiError
from astro_api.models import SavedKundli, User
from astro_api.timeresolve import resolve

router = APIRouter(prefix="/v1/kundlis", tags=["kundlis"])
MAX_PER_USER = 20


class PlaceIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    tz: str = Field(min_length=1, max_length=64)
    label: str | None = Field(default=None, max_length=200)
    city_id: int | None = None


class BirthIn(BaseModel):
    date: dt.date
    time: dt.time | None = None
    place: PlaceIn
    utc_offset: str | None = Field(default=None, pattern=r"^[+-]\d{2}:\d{2}$")
    fold: Literal[0, 1] | None = None


class KundliIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    gender: Literal["female", "male", "other"] | None = None
    birth: BirthIn


class KundliOut(BaseModel):
    id: uuid.UUID
    name: str
    gender: str | None
    birth: BirthIn
    unknown_time: bool
    birth_datetime_utc: dt.datetime
    utc_offset_used: str
    created_at: dt.datetime


def _out(k: SavedKundli) -> KundliOut:
    return KundliOut(
        id=k.id,
        name=k.name,
        gender=k.gender,
        birth=BirthIn(
            date=k.birth_date,
            time=k.birth_time,
            place=PlaceIn(lat=k.lat, lon=k.lon, tz=k.tz, label=k.place_label, city_id=k.city_id),
        ),
        unknown_time=k.unknown_time,
        birth_datetime_utc=k.birth_datetime_utc,
        utc_offset_used=k.utc_offset,
        created_at=k.created_at,
    )


@router.post("", status_code=201, response_model=KundliOut)
async def create_kundli(body: KundliIn, user: CurrentUser, db: Db) -> KundliOut:
    b = body.birth
    resolved = resolve(b.date, b.time, b.place.tz, b.utc_offset, b.fold)
    count = (
        await db.execute(select(func.count()).where(SavedKundli.user_id == user.id))
    ).scalar_one()
    if count >= MAX_PER_USER:
        raise ApiError(409, "limit_reached", f"You can save up to {MAX_PER_USER} kundlis.")
    k = SavedKundli(
        user_id=user.id,
        name=body.name.strip(),
        gender=body.gender,
        birth_date=b.date,
        birth_time=b.time,
        unknown_time=b.time is None,
        birth_datetime_utc=resolved.utc,
        tz=b.place.tz,
        utc_offset=resolved.utc_offset,
        lat=b.place.lat,
        lon=b.place.lon,
        place_label=b.place.label,
        city_id=b.place.city_id,
    )
    db.add(k)
    await db.commit()
    await db.refresh(k)
    return _out(k)


@router.get("", response_model=list[KundliOut])
async def list_kundlis(user: CurrentUser, db: Db) -> list[KundliOut]:
    rows = await db.execute(
        select(SavedKundli).where(SavedKundli.user_id == user.id).order_by(SavedKundli.created_at)
    )
    return [_out(k) for k in rows.scalars()]


async def _own(db: AsyncSession, user: User, kundli_id: uuid.UUID) -> SavedKundli:
    k = await db.get(SavedKundli, kundli_id)
    if k is None or k.user_id != user.id:  # other users' ids look exactly like missing ones
        raise ApiError(404, "kundli_not_found", "Kundli not found.")
    return k


@router.get("/{kundli_id}", response_model=KundliOut)
async def get_kundli(kundli_id: uuid.UUID, user: CurrentUser, db: Db) -> KundliOut:
    return _out(await _own(db, user, kundli_id))


@router.delete("/{kundli_id}", status_code=204)
async def delete_kundli(kundli_id: uuid.UUID, user: CurrentUser, db: Db) -> None:
    await db.delete(await _own(db, user, kundli_id))
    await db.commit()
