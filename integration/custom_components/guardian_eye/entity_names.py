"""Translate default entity names from the existing HA owner profile language."""

import asyncio
import json
from pathlib import Path
import re

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_IDENTITY = re.compile(r"guardian_eye_(nvr|[0-9a-f-]{36})_(.+)")


def normalize_language(language):
    language = str(language or "en").replace("_", "-").lower()
    if language.startswith("zh"):
        return "zh-Hant" if any(part in language for part in ("hant", "tw", "hk")) else "zh"
    return "pt-BR" if language == "pt-br" else language.split("-")[0]


class EntityNames:
    def __init__(self, hass, entry, coordinator):
        self.hass, self.entry, self.coordinator = hass, entry, coordinator
        self.store = Store(hass, 1, f"{DOMAIN}.entity_names.{entry.entry_id}")
        self.data = {"language": None, "names": {}}
        self._timer = None
        self._lock = asyncio.Lock()

    async def async_start(self):
        self.catalog = await self.hass.async_add_executor_job(
            lambda: json.loads(Path(__file__).with_name("entity_names.json").read_text())
        )
        self.data = await self.store.async_load() or self.data
        await self.async_apply()
        self.entry.async_on_unload(self.hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, self._changed))
        self.entry.async_on_unload(self.close)
        self.entry.async_on_unload(self.coordinator.async_add_listener(self._changed))

    @callback
    def close(self):
        if self._timer:
            self._timer()
            self._timer = None

    @callback
    def _changed(self, event=None):
        if event is not None:
            entity_id = event.data["entity_id"]
            entity = er.async_get(self.hass).async_get(entity_id)
            if entity is not None and self._key(entity) is None:
                return
        self.close()
        self._timer = async_call_later(self.hass, 0.5, self._scheduled_apply)

    async def _scheduled_apply(self, _now):
        self._timer = None
        await self.async_apply()

    def _key(self, entity):
        if entity.platform == DOMAIN and entity.config_entry_id == self.entry.entry_id and entity.domain == "camera":
            prefix, suffix = f"{self.entry.entry_id}_", "_live_viewer"
            if entity.unique_id.startswith(prefix) and entity.unique_id.endswith(suffix):
                camera_id = entity.unique_id[len(prefix):-len(suffix)]
                if camera_id in self.coordinator.data:
                    return self.catalog["keys"]["native"]["camera.live_viewer"]
            return None
        if entity.platform != "mqtt" or not (match := _IDENTITY.fullmatch(entity.unique_id)):
            return None
        camera_id, suffix = match.groups()
        if camera_id != "nvr" and camera_id not in self.coordinator.data:
            return None
        group = "nvr" if camera_id == "nvr" else "camera"
        return self.catalog["keys"][group].get(f"{entity.domain}.{suffix}")

    async def async_apply(self, language=None):
        async with self._lock:
            changed = False
            if language is not None:
                normalized = normalize_language(language)
                changed = self.data["language"] != normalized
                self.data["language"] = normalized
            if self.data["language"] is None:
                return
            translations = self.catalog["languages"].get(self.data["language"], self.catalog["languages"]["en"])
            registry = er.async_get(self.hass)
            managed = self.data["names"]
            for entity in list(registry.entities.values()):
                if not (key := self._key(entity)):
                    continue
                if entity.name is not None and entity.name != managed.get(entity.entity_id):
                    changed |= managed.pop(entity.entity_id, None) is not None
                    continue
                name = translations[key]
                if entity.platform == DOMAIN and not entity.device_id:
                    camera_id = entity.unique_id[len(self.entry.entry_id) + 1:-len("_live_viewer")]
                    name = f"{self.coordinator.data[camera_id]['name']} {name}"
                if entity.name != name:
                    registry.async_update_entity(entity.entity_id, name=name)
                changed |= managed.get(entity.entity_id) != name
                managed[entity.entity_id] = name
            remaining = {key: value for key, value in managed.items() if registry.async_get(key)}
            changed |= remaining != managed
            self.data["names"] = remaining
            if changed:
                self.store.async_delay_save(lambda: self.data, 1)


@websocket_api.websocket_command({
    vol.Required("type"): "guardian_eye/frontend_language",
    vol.Required("language"): vol.All(str, vol.Length(min=2, max=20)),
})
@websocket_api.async_response
async def websocket_frontend_language(hass, connection, msg):
    # Names in the HA registry are shared. A guest's browser must not rename them for everyone.
    if not connection.user.is_owner:
        connection.send_error(msg["id"], "unauthorized", "Only the owner may update shared names")
        return
    handled = False
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is ConfigEntryState.LOADED and (coordinator := getattr(entry, "runtime_data", None)):
            await coordinator.entity_names.async_apply(msg["language"])
            handled = True
    if not handled:
        connection.send_error(msg["id"], "not_ready", "Guardian Eye is not ready")
        return
    connection.send_result(msg["id"])
