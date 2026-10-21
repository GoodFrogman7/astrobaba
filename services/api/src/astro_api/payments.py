"""Payment gateways: Razorpay (Orders API over httpx) and a Fake one for development and tests.

The Fake gateway keeps its orders, payments and settlements in Redis so the API process and the
reconciliation CLI see the same data, and it produces correctly signed Razorpay-shaped webhooks
that go through the real webhook handler. Fake secrets are derived from SECRET_KEY; the Fake
provider is refused in staging/production (config.check_production_settings).

Nothing personal is sent to Razorpay: the receipt is our order id and notes carry ids only.
"""

import datetime as dt
import hashlib
import hmac
import json
import secrets
import string
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from redis.asyncio import Redis

from astro_api.config import Settings

RAZORPAY_API = "https://api.razorpay.com/v1"
FAKE_KEY_ID = "fake_key_id"
# Fake gateway fees, roughly Razorpay's domestic rate: 2% plus 18% GST on the fee.
FAKE_FEE_BPS = 200
FAKE_FEE_TAX_BPS = 1800


class PaymentProviderError(Exception):
    """The gateway refused or could not be reached. Message has no personal data."""


@dataclass(frozen=True)
class GatewayPayment:
    payment_id: str
    order_id: str | None
    amount_paise: int
    currency: str
    created_at: int  # epoch seconds


@dataclass(frozen=True)
class GatewaySettlement:
    settlement_id: str
    amount_paise: int  # net amount paid into the bank
    fees_paise: int  # gateway fees including tax
    created_at: int


@dataclass(frozen=True)
class SignedEvent:
    raw: bytes
    signature: str
    event_id: str
    payment_id: str | None = None


def _derive(settings: Settings, purpose: str) -> str:
    key = settings.secret_key.get_secret_value().encode()
    return hmac.new(key, purpose.encode(), hashlib.sha256).hexdigest()


def webhook_secret(settings: Settings) -> str:
    if settings.payments_provider == "razorpay":
        return settings.razorpay_webhook_secret.get_secret_value()
    return _derive(settings, "fake-razorpay-webhook-secret")


def checkout_secret(settings: Settings) -> str:
    if settings.payments_provider == "razorpay":
        return settings.razorpay_key_secret.get_secret_value()
    return _derive(settings, "fake-razorpay-key-secret")


def key_id(settings: Settings) -> str:
    return settings.razorpay_key_id if settings.payments_provider == "razorpay" else FAKE_KEY_ID


def sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def verify(secret: str, raw: bytes, signature: str | None) -> bool:
    if not secret or not signature:
        return False
    return hmac.compare_digest(sign(secret, raw), signature.strip().lower())


class Gateway(Protocol):
    provider: str

    @property
    def key_id(self) -> str: ...

    async def create_order(
        self, *, amount_paise: int, currency: str, receipt: str, notes: dict[str, str]
    ) -> str: ...

    def verify_checkout(self, order_id: str, payment_id: str, signature: str) -> bool: ...

    async def captured_payments(self, start: int, end: int) -> list[GatewayPayment]: ...

    async def settlements(self, start: int, end: int) -> list[GatewaySettlement]: ...


class RazorpayGateway:
    provider = "razorpay"

    def __init__(self, settings: Settings, http: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self.http = http

    @property
    def key_id(self) -> str:
        return self.settings.razorpay_key_id

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        auth = (self.settings.razorpay_key_id, self.settings.razorpay_key_secret.get_secret_value())
        try:
            if self.http is not None:
                r = await self.http.request(
                    method, f"{RAZORPAY_API}{path}", auth=auth, timeout=15, **kw
                )
            else:
                async with httpx.AsyncClient(timeout=15) as http:
                    r = await http.request(method, f"{RAZORPAY_API}{path}", auth=auth, **kw)
        except httpx.HTTPError as exc:
            raise PaymentProviderError(f"razorpay {path}: {type(exc).__name__}") from exc
        if r.status_code >= 400:
            raise PaymentProviderError(f"razorpay {path}: HTTP {r.status_code}")
        return r.json()

    async def create_order(
        self, *, amount_paise: int, currency: str, receipt: str, notes: dict[str, str]
    ) -> str:
        body = {
            "amount": amount_paise,
            "currency": currency,
            "receipt": receipt[:40],
            "notes": notes,
        }
        data = await self._request("POST", "/orders", json=body)
        return str(data["id"])

    def verify_checkout(self, order_id: str, payment_id: str, signature: str) -> bool:
        secret = self.settings.razorpay_key_secret.get_secret_value()
        return verify(secret, f"{order_id}|{payment_id}".encode(), signature)

    async def _paged(self, path: str, start: int, end: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        skip = 0
        while True:
            params = {"from": start, "to": end, "count": 100, "skip": skip}
            items = (await self._request("GET", path, params=params)).get("items", [])
            out.extend(items)
            if len(items) < 100:
                return out
            skip += 100

    async def captured_payments(self, start: int, end: int) -> list[GatewayPayment]:
        return [
            GatewayPayment(
                payment_id=str(p["id"]),
                order_id=p.get("order_id"),
                amount_paise=int(p["amount"]),
                currency=str(p["currency"]),
                created_at=int(p["created_at"]),
            )
            for p in await self._paged("/payments", start, end)
            if p.get("status") in ("captured", "refunded")
        ]

    async def settlements(self, start: int, end: int) -> list[GatewaySettlement]:
        return [
            GatewaySettlement(
                settlement_id=str(s["id"]),
                amount_paise=int(s["amount"]),
                fees_paise=int(s.get("fees", 0)),
                created_at=int(s["created_at"]),
            )
            for s in await self._paged("/settlements", start, end)
            if s.get("status") == "processed"
        ]


def _token(prefix: str) -> str:
    alphabet = string.ascii_letters + string.digits
    return prefix + "".join(secrets.choice(alphabet) for _ in range(14))


class FakeGateway:
    """Development/test stand-in for Razorpay. State lives in Redis under `fakepg:`."""

    provider = "fake"

    def __init__(self, settings: Settings, redis: Redis) -> None:
        self.settings = settings
        self.redis = redis

    @property
    def key_id(self) -> str:
        return FAKE_KEY_ID

    async def create_order(
        self, *, amount_paise: int, currency: str, receipt: str, notes: dict[str, str]
    ) -> str:
        order_id = _token("order_")
        record = {"amount": amount_paise, "currency": currency, "receipt": receipt}
        await self.redis.set(f"fakepg:order:{order_id}", json.dumps(record))
        return order_id

    def verify_checkout(self, order_id: str, payment_id: str, signature: str) -> bool:
        return verify(
            checkout_secret(self.settings), f"{order_id}|{payment_id}".encode(), signature
        )

    def _signed(self, body: dict[str, Any], payment_id: str | None = None) -> SignedEvent:
        raw = json.dumps(body).encode()
        return SignedEvent(
            raw=raw,
            signature=sign(webhook_secret(self.settings), raw),
            event_id=_token("evt_"),
            payment_id=payment_id,
        )

    async def simulate(self, order_id: str, outcome: str) -> SignedEvent:
        """Record a payment on `order_id` and return the webhook Razorpay would send."""
        raw_order = await self.redis.get(f"fakepg:order:{order_id}")
        if raw_order is None:
            raise KeyError(order_id)
        order = json.loads(raw_order)
        now = int(time.time())
        payment_id = _token("pay_")
        status = "captured" if outcome == "captured" else "failed"
        payment = {
            "id": payment_id,
            "entity": "payment",
            "amount": order["amount"],
            "currency": order["currency"],
            "status": status,
            "order_id": order_id,
            "method": "upi",
            "captured": status == "captured",
            # Razorpay sends contact details; the webhook handler must strip them.
            "email": "void@example.invalid",
            "contact": "+910000000000",
            "created_at": now,
        }
        if status == "captured":
            await self.redis.set(f"fakepg:payment:{payment_id}", json.dumps(payment))
            await self.redis.zadd("fakepg:payments", {payment_id: now})
            await self.redis.sadd("fakepg:unsettled", payment_id)
        else:
            payment |= {"error_code": "BAD_REQUEST_ERROR", "error_reason": "payment_failed"}
        body = {
            "entity": "event",
            "account_id": "acc_fake",
            "event": f"payment.{status}",
            "contains": ["payment"],
            "payload": {"payment": {"entity": payment}},
            "created_at": now,
        }
        return self._signed(body, payment_id)

    async def settle(self) -> SignedEvent | None:
        """Settle every captured, unsettled payment into one settlement (net of fees)."""
        ids = sorted(
            m.decode() if isinstance(m, bytes) else str(m)
            for m in await self.redis.smembers("fakepg:unsettled")
        )
        if not ids:
            return None
        gross = fees = 0
        for pid in ids:
            raw = await self.redis.get(f"fakepg:payment:{pid}")
            if raw is None:
                continue
            amount = int(json.loads(raw)["amount"])
            fee = amount * FAKE_FEE_BPS // 10000
            gross += amount
            fees += fee + fee * FAKE_FEE_TAX_BPS // 10000
        now = int(time.time())
        settlement = {
            "id": _token("setl_"),
            "entity": "settlement",
            "amount": gross - fees,
            "fees": fees,
            "tax": 0,
            "status": "processed",
            "utr": _token("UTR"),
            "created_at": now,
        }
        await self.redis.set(f"fakepg:settlement:{settlement['id']}", json.dumps(settlement))
        await self.redis.zadd("fakepg:settlements", {str(settlement["id"]): now})
        await self.redis.srem("fakepg:unsettled", *ids)
        body = {
            "entity": "event",
            "account_id": "acc_fake",
            "event": "settlement.processed",
            "contains": ["settlement"],
            "payload": {"settlement": {"entity": settlement}},
            "created_at": now,
        }
        return self._signed(body)

    async def _between(self, zkey: str, prefix: str, start: int, end: int) -> list[dict[str, Any]]:
        out = []
        for member in await self.redis.zrangebyscore(zkey, start, f"({end}"):
            mid = member.decode() if isinstance(member, bytes) else str(member)
            raw = await self.redis.get(f"{prefix}{mid}")
            if raw is not None:
                out.append(json.loads(raw))
        return out

    async def captured_payments(self, start: int, end: int) -> list[GatewayPayment]:
        return [
            GatewayPayment(
                payment_id=p["id"],
                order_id=p["order_id"],
                amount_paise=int(p["amount"]),
                currency=p["currency"],
                created_at=int(p["created_at"]),
            )
            for p in await self._between("fakepg:payments", "fakepg:payment:", start, end)
        ]

    async def settlements(self, start: int, end: int) -> list[GatewaySettlement]:
        return [
            GatewaySettlement(
                settlement_id=s["id"],
                amount_paise=int(s["amount"]),
                fees_paise=int(s["fees"]),
                created_at=int(s["created_at"]),
            )
            for s in await self._between("fakepg:settlements", "fakepg:settlement:", start, end)
        ]


def make_gateway(settings: Settings, redis: Redis) -> RazorpayGateway | FakeGateway:
    if settings.payments_provider == "razorpay":
        return RazorpayGateway(settings)
    return FakeGateway(settings, redis)


def epoch_to_dt(value: Any) -> dt.datetime | None:
    try:
        return dt.datetime.fromtimestamp(int(value), dt.UTC)
    except (TypeError, ValueError, OverflowError):
        return None
