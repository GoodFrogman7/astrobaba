from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Declarative base for all API tables. Tables arrive with the phases that need them."""
