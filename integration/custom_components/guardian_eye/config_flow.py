"""One Guardian URL and grant per Home Assistant integration instance."""

from __future__ import annotations

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import selector

from .client import GuardianClient, GuardianError, GuardianAuthError, normalize_url
from .const import DOMAIN, CONF_URL, CONF_TOKEN
from .pairing import async_pair, PairingError
from yarl import URL


class GuardianEyeConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure or replace the backend-only Guardian credential."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        if user_input and CONF_URL in user_input:
            return await self._configure("manual", user_input)
        if user_input and "code" in user_input:
            return await self._pair("pair", user_input)
        return self.async_show_menu(step_id="user", menu_options=["pair", "manual"])

    async def async_step_pair(self, user_input=None):
        return await self._pair("pair", user_input)

    async def async_step_manual(self, user_input=None):
        return await self._configure("manual", user_input)

    async def async_step_reconfigure(self, user_input=None):
        return await self.async_step_user(user_input)

    async def async_step_reauth(self, entry_data):
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input=None):
        return await self.async_step_user(user_input)

    def _existing_entry(self):
        source = self.context.get("source")
        if source == config_entries.SOURCE_RECONFIGURE:
            return self._get_reconfigure_entry()
        if source == config_entries.SOURCE_REAUTH:
            return self._get_reauth_entry()
        return None

    async def _pair(self, step, user_input):
        errors = {}
        if user_input is not None:
            try:
                data = await async_pair(self.hass, user_input.get("code", ""))
                client = GuardianClient(async_get_clientsession(self.hass), data[CONF_URL], data[CONF_TOKEN], data["certificate_sha256"])
                await client.bootstrap()
                await client.cameras()
            except PairingError as error:
                errors["base"] = str(error)
            except (GuardianError, ValueError):
                errors["base"] = "cannot_connect"
            else:
                entry = self._existing_entry()
                if entry is None:
                    target = URL(data[CONF_URL])
                    entry = next((item for item in self._async_current_entries()
                        if (URL(item.data[CONF_URL]).host, URL(item.data[CONF_URL]).port) == (target.host, target.port)), None)
                if entry is not None:
                    return self.async_update_reload_and_abort(entry, data_updates=data)
                return self.async_create_entry(title="Guardian Eye", data=data)
        return self.async_show_form(step_id=step, data_schema=vol.Schema({
            vol.Required("code"): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD))
        }), errors=errors)

    async def _configure(self, step, user_input):
        errors = {}
        entry = self._existing_entry()
        if user_input is not None:
            try:
                url = normalize_url(user_input[CONF_URL])
                token = user_input[CONF_TOKEN].strip()
                if not token or len(token) > 512 or "\n" in token or "\r" in token:
                    raise ValueError()
                # URLs are not stable device IDs. Use HA's entry identity, and check duplicates separately.
                if any(
                    e.data[CONF_URL] == url
                    and (entry is None or e.entry_id != entry.entry_id)
                    for e in self._async_current_entries()
                ):
                    return self.async_abort(reason="already_configured")
                fingerprint = entry.data.get("certificate_sha256") if entry and entry.data[CONF_URL] == url else None
                client = GuardianClient(async_get_clientsession(self.hass), url, token, fingerprint)
                await client.bootstrap()
                await client.cameras()
            except GuardianAuthError:
                errors["base"] = "invalid_auth"
            except GuardianError:
                errors["base"] = "cannot_connect"
            except (ValueError, KeyError):
                errors["base"] = "invalid_url"
            else:
                data = {CONF_URL: url, CONF_TOKEN: token}
                if entry is not None:
                    if entry.data[CONF_URL] != url:
                        data.update(certificate_sha256=None, proxy_video=False)
                    return self.async_update_reload_and_abort(entry, data_updates=data)
                return self.async_create_entry(title="Guardian Eye", data=data)

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_URL, default=entry.data[CONF_URL] if entry else ""
                ): str,
                vol.Required(CONF_TOKEN): selector.TextSelector(
                    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                ),
            }
        )
        return self.async_show_form(step_id=step, data_schema=schema, errors=errors)
