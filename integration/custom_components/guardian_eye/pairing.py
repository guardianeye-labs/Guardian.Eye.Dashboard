"""Connect using the MQTT settings already entered in GE."""
from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import ipaddress
import json
from pathlib import Path
import re

import aiohttp
from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from yarl import URL


class PairingError(Exception):
    """Only stable, non-secret errors reach forms or logs."""


def parse_code(code: str) -> dict:
    try:
        if not isinstance(code, str) or len(code) > 2048 or not code.strip().startswith("GEHA1."):
            raise ValueError()
        encoded = code.strip()[6:]
        data = json.loads(base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
        url = URL(data["url"])
        address = ipaddress.ip_address(url.host)
        secret = base64.b64decode(data["secret"], validate=True)
        pin = bytes.fromhex(data["sha256"])
        expires = datetime.fromisoformat(data["expiresAt"].replace("Z", "+00:00"))
        if (url.scheme != "https" or url.user is not None or url.query_string or url.fragment
            or url.path not in ("", "/") or not url.port or address.is_unspecified or address.is_multicast
            or len(secret) != 32 or len(pin) != 32 or expires.tzinfo is None
            or type(data["contract"]) is not int or not isinstance(data["version"], str)
            or type(data["development"]) is not bool):
            raise ValueError()
        if expires <= datetime.now(timezone.utc):
            raise PairingError("code_expired")
        return data
    except PairingError:
        raise
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError):
        raise PairingError("invalid_code") from None


def check_compatibility(data: dict, release: dict) -> None:
    rule = release["guardianEye"]
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?", data["version"])
    compatible = data["contract"] == rule["contractVersion"] and match is not None
    if compatible and data["development"]:
        compatible = rule.get("allowDevelopmentBuild") is True
    elif compatible:
        # A release names the oldest Guardian Eye it works with; newer builds on the same contract keep
        # working. Breaking changes bump contractVersion, so maxVersionExclusive is not an upper limit.
        version = tuple(int(x) for x in match.groups()[:3])
        lower = tuple(int(x) for x in rule["minVersion"].split("."))
        compatible = lower <= version and (match[4] is None or rule.get("allowPrerelease") is True)
    if not compatible:
        raise PairingError("incompatible_version")


def require_mqtt(hass) -> None:
    entries = [entry for entry in hass.config_entries.async_entries("mqtt") if entry.state == ConfigEntryState.LOADED]
    if len(entries) != 1:
        raise PairingError("mqtt_required")


async def async_pair(hass, code: str) -> dict:
    data = parse_code(code)
    release = await hass.async_add_executor_job(
        lambda: json.loads((Path(__file__).parent / "frontend/guardian-eye-dashboard-release.json").read_text()))
    check_compatibility(data, release)
    require_mqtt(hass)
    try:
        async with async_get_clientsession(hass).post(
            str(URL(data["url"]).origin()) + "/pair", json={},
            headers={"Authorization": "Bearer " + data["secret"]},
            ssl=aiohttp.Fingerprint(bytes.fromhex(data["sha256"])),
            allow_redirects=False, timeout=aiohttp.ClientTimeout(total=40),
        ) as response:
            raw = bytearray()
            async for chunk in response.content.iter_chunked(4096):
                raw.extend(chunk)
                if len(raw) > 4096:
                    raise PairingError("cannot_connect")
            body = json.loads(raw)
            if response.status != 200:
                reason = body.get("reason") if isinstance(body, dict) else None
                raise PairingError(reason if reason in {"code_expired", "code_used", "setup_busy", "mqtt_unreachable",
                    "video_unreachable", "invalid_broker"} else "cannot_connect")
            url = URL(body["url"])
            if (url.scheme != "https" or url.host != URL(data["url"]).host or url.user is not None
                or url.path not in ("", "/") or url.query_string or url.fragment
                or not isinstance(body["token"], str) or not 1 <= len(body["token"]) <= 512
                or "\n" in body["token"] or "\r" in body["token"]
                or len(bytes.fromhex(body["certificateSha256"])) != 32):
                raise PairingError("cannot_connect")
            return {"url": str(url.origin()), "token": body["token"],
                    "certificate_sha256": body["certificateSha256"], "proxy_video": True}
    except PairingError:
        raise
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, KeyError, TypeError, AttributeError):
        raise PairingError("cannot_connect") from None
