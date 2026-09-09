"""Camera identities and permissions for the Guardian Eye dashboard's live player."""

from __future__ import annotations

from homeassistant.components.camera import Camera, CameraEntityFeature
from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .devices import camera_device


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = entry.runtime_data
    known = set()

    def add_cameras():
        new = set(coordinator.data) - known
        known.update(new)
        async_add_entities(
            GuardianCamera(coordinator, entry.entry_id, camera_id)
            for camera_id in sorted(new)
        )

    add_cameras()
    entry.async_on_unload(coordinator.async_add_listener(add_cameras))


class GuardianCamera(CoordinatorEntity, Camera):
    """A live camera accessed through the authenticated broker and custom dashboard card.

    Native HA WebRTC signaling is deliberately not advertised. No stream URL or viewer secret is state.
    """

    _attr_has_entity_name = True
    _attr_translation_key = "live_viewer"
    _attr_supported_features = CameraEntityFeature(0)

    def __init__(self, coordinator, entry_id, camera_id):
        CoordinatorEntity.__init__(self, coordinator)
        Camera.__init__(self)
        self.camera_id = camera_id
        self._attr_unique_id = f"{entry_id}_{camera_id}_live_viewer"
        self._camera_name = coordinator.data[camera_id]["name"]
        self._link_device()

    @callback
    def _link_device(self):
        # HA helper entities link directly to a device owned by another integration.
        # Repeating its identifiers in DeviceInfo would create a second device in HA 2026.8+.
        self.device_entry = camera_device(self.coordinator.hass, self.camera_id)
        self._attr_translation_placeholders = {
            "camera_name": "" if self.device_entry else f"{self._camera_name} "
        }
        self.__dict__.pop("name", None)

    @callback
    def _device_changed(self, event):
        registry = dr.async_get(self.hass)
        changed = registry.async_get(event.data["device_id"])
        identity = ("mqtt", f"guardian_eye_{self.camera_id}")
        if not (
            self.device_entry and self.device_entry.id == event.data["device_id"]
            or changed and identity in changed.identifiers
        ):
            return
        self._link_device()
        er.async_get(self.hass).async_update_entity(
            self.entity_id,
            device_id=self.device_entry.id if self.device_entry else None,
            has_entity_name=self.has_entity_name,
            original_name=self.name,
        )
        self.async_write_ha_state()

    @property
    def available(self):
        return super().available and self.camera_id in self.coordinator.data

    @property
    def is_on(self):
        return self.coordinator.data.get(self.camera_id, {}).get("powered_on", False)

    async def async_camera_image(self, width=None, height=None):
        return None

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        self.coordinator.entities[self.entity_id] = self.camera_id
        self.async_on_remove(
            self.hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, self._device_changed)
        )

    async def async_will_remove_from_hass(self):
        self.coordinator.entities.pop(self.entity_id, None)
        await super().async_will_remove_from_hass()
