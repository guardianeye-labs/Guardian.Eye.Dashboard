"""Guardian Eye live access broker."""

from __future__ import annotations

import asyncio
from datetime import timedelta
import logging

from homeassistant.components import websocket_api
from homeassistant.const import Platform
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import GuardianClient, GuardianAuthError, GuardianError
from .const import DOMAIN, CONF_URL, CONF_TOKEN
from .devices import migrate_camera_devices
from .entity_names import EntityNames, websocket_frontend_language
from .http import GuardianOpenView

_LOGGER = logging.getLogger(__name__)


class GuardianCoordinator(DataUpdateCoordinator):
    """Only non-secret camera metadata is cached or projected into entities."""

    def __init__(self, hass, entry):
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            config_entry=entry,
            update_interval=timedelta(seconds=30),
        )
        self.client = GuardianClient(
            async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN]
        )
        self.entities = {}
        self.open_slots = asyncio.Semaphore(8)

    async def _async_update_data(self):
        try:
            return await self.client.cameras()
        except GuardianAuthError:
            raise ConfigEntryAuthFailed(
                "Guardian authorization must be renewed"
            ) from None
        except GuardianError:
            raise UpdateFailed("Guardian Eye is unavailable") from None


async def async_setup(hass, config):
    hass.http.register_view(GuardianOpenView())
    websocket_api.async_register_command(hass, websocket_frontend_language)
    return True


async def async_setup_entry(hass, entry):
    coordinator = GuardianCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    coordinator.entity_names = EntityNames(hass, entry, coordinator)
    migrate_camera_devices(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, [Platform.CAMERA])
    await coordinator.entity_names.async_start()
    return True


async def async_unload_entry(hass, entry):
    return await hass.config_entries.async_unload_platforms(entry, [Platform.CAMERA])
