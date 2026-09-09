"""Install the bundled panel through HA APIs; keep existing dashboards and entity IDs."""
from pathlib import Path
import json
from urllib.parse import urlsplit

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.lovelace import LOVELACE_DATA
from homeassistant.components.lovelace.dashboard import LovelaceStorage, ConfigNotFound
from homeassistant.components.lovelace.resources import ResourceStorageCollection

PANEL_PATH = "guardian-eye"
STATIC_PATH = "/guardian_eye/frontend"


def is_guardian_resource(url):
    value = urlsplit(url)
    return (value.path.startswith(("/local/community/guardian-eye-dashboard/", STATIC_PATH + "/"))
            and value.path.rsplit("/", 1)[-1] in ("Guardian.Eye.Dashboard.js", "guardian-eye-dashboard.js")) or (
        value.hostname == "guardianeye-labs.github.io" and value.path.startswith("/Guardian.Eye.Dashboard/")
        and value.path.rsplit("/", 1)[-1] in ("Guardian.Eye.Dashboard.js", "guardian-eye-dashboard.js"))


async def async_setup_panel(hass):
    folder = Path(__file__).parent / "frontend"
    release = await hass.async_add_executor_job(lambda: json.loads((folder / "guardian-eye-dashboard-release.json").read_text()))
    await hass.http.async_register_static_paths([StaticPathConfig(STATIC_PATH, str(folder), False)])
    url = f"{STATIC_PATH}/Guardian.Eye.Dashboard.js?v={release['version']}"
    data = hass.data[LOVELACE_DATA]
    resources = data.resources
    if isinstance(resources, ResourceStorageCollection):
        await resources.async_get_info()
        existing = [item for item in resources.async_items() if is_guardian_resource(item["url"])]
        if existing:
            await resources.async_update_item(existing[0]["id"], {"url": url, "res_type": "module"})
            for duplicate in existing[1:]:
                await resources.async_delete_item(duplicate["id"])
        else:
            await resources.async_create_item({"url": url, "res_type": "module"})
    else:
        # YAML dashboards can also load modules without editing configuration.yaml.
        frontend.add_extra_js_url(hass, url)

    # A user's existing panel at this path owns its layout. Do not overwrite or duplicate it.
    if PANEL_PATH in data.dashboards or frontend.async_panel_exists(hass, PANEL_PATH):
        return
    dashboard = LovelaceStorage(hass, {"id": PANEL_PATH, "url_path": PANEL_PATH,
        "title": "Guardian Eye", "mode": "storage", "show_in_sidebar": True, "require_admin": False})
    try:
        await dashboard.async_load(False)
    except ConfigNotFound:
        await dashboard.async_save({"strategy": {"type": "custom:guardian-eye"}})
    data.dashboards[PANEL_PATH] = dashboard
    frontend.async_register_built_in_panel(hass, "lovelace", sidebar_title="Guardian Eye",
        sidebar_icon="mdi:cctv", frontend_url_path=PANEL_PATH, config={"mode": "storage"},
        config_panel_domain="guardian_eye")
