"""Authenticated HA signalling proxy. Media still travels directly over WebRTC."""
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import time
from uuid import uuid4

import aiohttp
from aiohttp import web
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import entity_registry as er
from yarl import URL


@dataclass
class Lease:
    user_id: str
    entity_id: str
    entry: object
    coordinator: object
    camera_id: str
    descriptor: dict
    expires: float
    resource: str | None = None
    busy: bool = False


class GuardianWhepView(HomeAssistantView):
    url = "/api/guardian_eye/whep/{lease_id}"
    name = "api:guardian_eye:whep"
    requires_auth = True

    def __init__(self):
        self.leases = {}

    def issue(self, user, entity_id, entry, coordinator, camera_id, descriptor):
        now = time.monotonic()
        self.leases = {key: lease for key, lease in self.leases.items() if lease.expires > now}
        if len(self.leases) >= 256:
            return None
        ident = uuid4().hex
        self.leases[ident] = Lease(user.id, entity_id, entry, coordinator, camera_id, descriptor, now + 120)
        return {"cameraId": camera_id, "publicationId": descriptor["publicationId"],
                "whepUrl": f"/api/guardian_eye/whep/{ident}", "authorization": "HomeAssistant",
                "viaHomeAssistant": True, "expiresAt": descriptor["expiresAt"]}

    @staticmethod
    def allowed(hass, user, lease):
        entity = er.async_get(hass).async_get(lease.entity_id)
        return (user.id == lease.user_id and user.is_active
            and user.permissions.check_entity(lease.entity_id, POLICY_READ)
            and entity is not None and not entity.disabled_by and entity.config_entry_id == lease.entry.entry_id
            and hass.config_entries.async_get_entry(lease.entry.entry_id) is lease.entry
            and lease.entry.state == ConfigEntryState.LOADED and not lease.entry.disabled_by
            and getattr(lease.entry, "runtime_data", None) is lease.coordinator
            and lease.coordinator.entities.get(lease.entity_id) == lease.camera_id)

    async def post(self, request, lease_id):
        return await self._request(request, lease_id)

    async def delete(self, request, lease_id):
        return await self._request(request, lease_id)

    async def _request(self, request, lease_id):
        lease = self.leases.get(lease_id)
        if lease is None or lease.expires <= time.monotonic():
            return web.Response(status=404)
        if not self.allowed(request.app["hass"], request["hass_user"], lease):
            return web.Response(status=403)
        if lease.busy:
            return web.Response(status=409)
        creating = request.method == "POST"
        if creating and (lease.resource or datetime.fromisoformat(lease.descriptor["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)):
            return web.Response(status=409)
        if not creating and not lease.resource:
            return web.Response(status=404)
        if creating and (request.content_type != "application/sdp" or (request.content_length or 0) > 65536):
            return web.Response(status=400)
        lease.busy = True
        keep = False
        try:
            async with asyncio.timeout(12):
                data = bytearray()
                async for chunk in request.content.iter_chunked(8192):
                    data.extend(chunk)
                    if len(data) > (65536 if creating else 0):
                        return web.Response(status=400)
                client = lease.coordinator.client
                endpoint = lease.descriptor["whepUrl"] if creating else lease.resource
                async with client.session.request(request.method, endpoint, data=bytes(data) if creating else None,
                    headers={"Authorization": lease.descriptor["authorization"], "Content-Type": "application/sdp"},
                    ssl=client.fingerprint, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10)) as upstream:
                    if creating and upstream.status == 201:
                        base = URL(endpoint)
                        location = upstream.headers.get("Location")
                        resource = base.join(URL(location)) if location else None
                        if (resource is None or resource.origin() != base.origin() or resource.user is not None
                            or resource.query_string or resource.fragment or not resource.path.startswith(base.path + "/")):
                            return web.Response(status=502)
                        lease.resource = str(resource)
                    payload = bytearray()
                    async for chunk in upstream.content.iter_chunked(8192):
                        payload.extend(chunk)
                        if len(payload) > 131072:
                            return web.Response(status=502)
                    if not creating:
                        if upstream.status not in (200, 204, 404):
                            return web.Response(status=502)
                        self.leases.pop(lease_id, None)
                        return web.Response(status=204, headers={"Cache-Control": "no-store"})
                    if upstream.status != 201:
                        return web.Response(status=upstream.status if upstream.status in (401, 403, 404, 409, 429) else 502)
                    lease.expires = time.monotonic() + 86400
                    if not self.allowed(request.app["hass"], request["hass_user"], lease):
                        return web.Response(status=403)
                    keep = True
                    return web.Response(status=201, body=bytes(payload), content_type="application/sdp",
                        headers={"Location": f"/api/guardian_eye/whep/{lease_id}", "Cache-Control": "no-store"})
        except (aiohttp.ClientError, TimeoutError, ValueError):
            return web.Response(status=502)
        finally:
            if creating and not keep and lease.resource:
                try:
                    client = lease.coordinator.client
                    async with client.session.delete(lease.resource,
                        headers={"Authorization": lease.descriptor["authorization"]}, ssl=client.fingerprint,
                        allow_redirects=False, timeout=aiohttp.ClientTimeout(total=2)):
                        pass
                except (aiohttp.ClientError, TimeoutError):
                    pass
                self.leases.pop(lease_id, None)
            lease.busy = False
