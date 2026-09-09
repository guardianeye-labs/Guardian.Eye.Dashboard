"""Bounded server-to-server API. Guardian credentials never leave this client."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from uuid import UUID

import aiohttp
from yarl import URL

REASONS = {
    "disabled",
    "camera_off",
    "starting",
    "rate_limited",
    "limit_exceeded",
    "not_publishing",
    "encoder_unavailable",
    "router_unavailable",
    "tls_invalid",
    "unavailable",
    "not_found",
    "catalog_unavailable",
    "forbidden",
    "unauthorized",
}


class GuardianError(Exception):
    """Safe error: no response payload, URL or credential in exception text."""

    def __init__(self, reason: str = "unavailable", status: int = 503) -> None:
        self.reason = (
            reason if isinstance(reason, str) and reason in REASONS else "unavailable"
        )
        self.status = status
        super().__init__(self.reason)


class GuardianAuthError(GuardianError):
    """The configured Guardian grant is invalid or lacks permission."""


def normalize_url(value: str) -> str:
    """Accept an explicit HTTP(S) origin; never accept inline credentials."""
    url = URL(value.strip())
    if (
        url.scheme not in ("http", "https")
        or not url.host
        or url.user is not None
        or url.password is not None
        or url.query_string
        or url.fragment
        or url.path not in ("", "/")
        or url.host in ("0.0.0.0", "::")
    ):
        raise ValueError("invalid_url")
    return str(url.origin())


class GuardianClient:
    """The token is kept in backend memory/config entry only."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        self.session = session
        self.url = normalize_url(url)
        self._token = token.strip()

    async def request(self, method: str, path: str, **kwargs) -> dict:
        try:
            async with self.session.request(
                method,
                self.url + path,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=15),
                allow_redirects=False,
                **kwargs,
            ) as response:
                if response.status in (401, 403):
                    raise GuardianAuthError("unauthorized", response.status)
                raw = bytearray()
                async for chunk in response.content.iter_chunked(8192):
                    raw.extend(chunk)
                    if len(raw) > 65536:
                        raise GuardianError()
                try:
                    body = json.loads(raw)
                except (ValueError, RecursionError):
                    raise GuardianError() from None
                if not isinstance(body, dict):
                    raise GuardianError()
                if response.status != 200:
                    raise GuardianError(
                        body.get("reason", "unavailable"), response.status
                    )
                return body
        except (aiohttp.ClientError, asyncio.TimeoutError):
            raise GuardianError("unavailable") from None

    async def bootstrap(self) -> dict:
        result = await self.request("GET", "/client/bootstrap")
        capabilities = result.get("capabilities")
        if (
            result.get("apiVersion") != 1
            or not isinstance(capabilities, list)
            or "live" not in capabilities
        ):
            raise GuardianError()
        return result

    async def cameras(self) -> dict[str, dict]:
        result = await self.request("GET", "/cameras")
        cameras = result.get("cameras")
        if not isinstance(cameras, list) or len(cameras) > 256:
            raise GuardianError()
        safe = {}
        for camera in cameras:
            try:
                camera_id = str(UUID(camera["cameraId"]))
                name = camera["name"]
                if not isinstance(name, str) or not isinstance(
                    camera["poweredOn"], bool
                ):
                    raise ValueError()
                safe[camera_id] = {
                    "name": name[:256],
                    "powered_on": camera["poweredOn"],
                }
            except (KeyError, ValueError, TypeError, AttributeError):
                raise GuardianError() from None
        return safe

    async def open(self, camera_id: str) -> dict:
        camera_id = str(UUID(camera_id))
        result = await self.request("POST", f"/live/{camera_id}/open", json={})
        try:
            whep = URL(result["whepUrl"])
            base = URL(self.url)
            expiry = datetime.fromisoformat(result["expiresAt"].replace("Z", "+00:00"))
            authorization = result["authorization"]
            if (
                str(UUID(result["cameraId"])) != camera_id
                or whep.host != base.host
                or whep.scheme != base.scheme
                or whep.user is not None
                or whep.query_string
                or whep.fragment
                or whep.path != f"/live/{UUID(camera_id).hex}/whep"
                or not isinstance(authorization, str)
                or not authorization.startswith("Bearer ")
                or len(authorization) > 1024
                or "\r" in authorization
                or "\n" in authorization
                or expiry.tzinfo is None
                or expiry <= datetime.now(timezone.utc)
            ):
                raise ValueError()
            publication_id = str(UUID(result["publicationId"]))
        except (KeyError, TypeError, ValueError, AttributeError):
            raise GuardianError() from None
        # Explicit projection: never echo arbitrary upstream fields, especially a permanent token.
        return {
            "cameraId": camera_id,
            "publicationId": publication_id,
            "whepUrl": str(whep),
            "authorization": authorization,
            "expiresAt": expiry.isoformat(),
            "expiryPolicy": "shared_camera_lease",
        }
