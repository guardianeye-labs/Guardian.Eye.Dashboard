"""HA auth and entity permissions terminate here; Guardian auth is server-to-server."""

from __future__ import annotations

import asyncio
from collections import deque
import json
import time

from aiohttp import web
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import entity_registry as er

from .client import GuardianAuthError, GuardianError
from .const import DOMAIN


def response(body, status=200):
    return web.json_response(body, status=status, headers={"Cache-Control": "no-store"})


class GuardianOpenView(HomeAssistantView):
    url = "/api/guardian_eye/live/open"
    name = "api:guardian_eye:live:open"
    requires_auth = True

    def __init__(self, whep=None):
        self._requests = {}
        self._whep = whep

    def _admit(self, user_id):
        now = time.monotonic()
        self._requests = {
            key: q for key, q in self._requests.items() if q and now - q[-1] < 60
        }
        if user_id not in self._requests and len(self._requests) >= 512:
            return False
        queue = self._requests.setdefault(user_id, deque())
        while queue and now - queue[0] >= 60:
            queue.popleft()
        if len(queue) >= 20:
            return False
        queue.append(now)
        return True

    async def post(self, request):
        hass = request.app["hass"]
        user = request["hass_user"]
        if not self._admit(user.id):
            return response({"reason": "rate_limited"}, 429)
        if (
            request.content_type != "application/json"
            or (request.content_length or 0) > 1024
        ):
            return response({"reason": "invalid_request"}, 400)
        try:
            async with asyncio.timeout(5):
                payload = bytearray()
                async for chunk in request.content.iter_chunked(1024):
                    payload.extend(chunk)
                    if len(payload) > 1024:
                        return response({"reason": "invalid_request"}, 400)
                body = json.loads(payload)
        except (ValueError, RecursionError, TimeoutError):
            return response({"reason": "invalid_request"}, 400)
        if (
            not isinstance(body, dict)
            or set(body) != {"entity_id"}
            or not isinstance(body["entity_id"], str)
        ):
            return response({"reason": "invalid_request"}, 400)
        entity_id = body["entity_id"]
        if not user.permissions.check_entity(entity_id, POLICY_READ):
            return response({"reason": "forbidden"}, 403)
        entity = er.async_get(hass).async_get(entity_id)
        if (
            entity is None
            or entity.platform != DOMAIN
            or entity.domain != "camera"
            or entity.disabled_by
        ):
            return response({"reason": "not_found"}, 404)
        entry = hass.config_entries.async_get_entry(entity.config_entry_id)
        if entry is None or entry.state != ConfigEntryState.LOADED or entry.disabled_by:
            return response({"reason": "not_found"}, 404)
        coordinator = getattr(entry, "runtime_data", None) if entry else None
        camera_id = coordinator.entities.get(entity_id) if coordinator else None
        if not camera_id or camera_id not in coordinator.data:
            return response({"reason": "not_found"}, 404)
        if coordinator.open_slots.locked():
            return response({"reason": "rate_limited"}, 429)
        try:
            async with asyncio.timeout(18), coordinator.open_slots:
                descriptor = await coordinator.client.open(camera_id)
        except GuardianAuthError:
            entry.async_start_reauth(hass)
            return response({"reason": "guardian_auth_required"}, 409)
        except GuardianError as error:
            status = error.status if error.status in (400, 404, 409, 429, 503) else 503
            return response({"reason": error.reason}, status)
        except TimeoutError:
            return response({"reason": "unreachable"}, 504)
        # Permissions or entity/config entry identity may change while Guardian wakes the camera.
        current_entity = er.async_get(hass).async_get(entity_id)
        if not user.is_active or not user.permissions.check_entity(
            entity_id, POLICY_READ
        ):
            return response({"reason": "forbidden"}, 403)
        if (
            current_entity is None
            or current_entity.disabled_by
            or current_entity.config_entry_id != entry.entry_id
            or getattr(entry, "runtime_data", None) is not coordinator
            or coordinator.entities.get(entity_id) != camera_id
        ):
            return response({"reason": "not_found"}, 404)
        if entry.data.get("proxy_video") and self._whep:
            descriptor = self._whep.issue(user, entity_id, entry, coordinator, camera_id, descriptor)
            if descriptor is None:
                return response({"reason": "rate_limited"}, 429)
        return response(descriptor)
