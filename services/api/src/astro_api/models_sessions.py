"""Chat message table (migration 0005). Owned by the sessions work.

Message text is never stored in clear: `ciphertext` is AES-256-GCM over the UTF-8 text with
AAD `{session_id}:{seq}` (chat_crypto.py). `key_id` names the key so keys can rotate.
"""

import datetime as dt
import uuid

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from astro_api.db import Base

MESSAGE_SENDERS = ("user", "astrologer", "system")


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        UniqueConstraint("session_id", "seq", name="uq_chat_messages_session_seq"),
        # A resent client_id from the same sender is the same message (NULLs never collide).
        UniqueConstraint("session_id", "sender", "client_id", name="uq_chat_messages_client_id"),
        CheckConstraint("sender IN ('user', 'astrologer', 'system')", name="chat_sender_known"),
        CheckConstraint("seq > 0", name="chat_seq_pos"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("consult_sessions.id", ondelete="CASCADE")
    )
    seq: Mapped[int] = mapped_column(Integer)
    sender: Mapped[str] = mapped_column(Text)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    nonce: Mapped[bytes] = mapped_column(LargeBinary)
    key_id: Mapped[str] = mapped_column(Text)
    client_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
