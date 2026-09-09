"""Diagnostics omit the config entry and all credentials by construction."""


async def async_get_config_entry_diagnostics(hass, entry):
    coordinator = getattr(entry, "runtime_data", None)
    return {
        "version": 1,
        "available": bool(coordinator and coordinator.last_update_success),
        "camera_count": len(coordinator.data or {}) if coordinator else 0,
    }
