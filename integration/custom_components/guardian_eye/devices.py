"""Link live helpers to MQTT-owned cameras without registering duplicate devices."""

from homeassistant.core import callback
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DOMAIN


@callback
def camera_device(hass, camera_id):
    """Resolve an unambiguous MQTT camera identity, never a display name."""
    matches = [
        device
        for device in dr.async_get(hass).async_get_devices(
            identifiers={("mqtt", f"guardian_eye_{camera_id}")}
        )
        if (entry := hass.config_entries.async_get_entry(device.config_entry_id))
        and entry.domain == "mqtt"
    ]
    return matches[0] if len(matches) == 1 else None


@callback
def migrate_camera_devices(hass, entry):
    """Retire legacy live-only devices, preserving entity identities and user settings."""
    devices = dr.async_get(hass)
    entities = er.async_get(hass)
    for device in list(dr.async_entries_for_config_entry(devices, entry.entry_id)):
        camera_ids = [value for domain, value in device.identifiers if domain == DOMAIN]
        if len(camera_ids) != 1:
            continue
        camera_id = camera_ids[0]
        attached = er.async_entries_for_device(entities, device.id, include_disabled_entities=True)
        if any(
            entity.config_entry_id != entry.entry_id
            or entity.unique_id != f"{entry.entry_id}_{camera_id}_live_viewer"
            for entity in attached
        ):
            continue
        target = camera_device(hass, camera_id)
        for entity in attached:
            changes = {"device_id": target.id if target else None}
            if entity.area_id is None and device.area_id is not None:
                changes["area_id"] = device.area_id
            if device.labels:
                changes["labels"] = entity.labels | device.labels
            if entity.name is None and device.name_by_user:
                changes["name"] = f"{device.name_by_user} Live"
            if device.disabled_by and entity.disabled_by in (None, er.RegistryEntryDisabler.DEVICE):
                changes["disabled_by"] = er.RegistryEntryDisabler.USER
            entities.async_update_entity(entity.entity_id, **changes)
        devices.async_remove_device(device.id)
