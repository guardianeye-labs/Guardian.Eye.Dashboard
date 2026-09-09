# Guardian Eye for Home Assistant

![Guardian Eye dashboard](docs/guardian-eye.png)

Camera dashboard, authenticated live viewing, MQTT sensors and camera controls.

Download the package suggested in **Guardian Eye → Settings → Smart Home → Home Assistant**.
Install its `custom_components/guardian_eye` folder in HA and restart HA once. Then click
**Connect Home Assistant** in GE and paste the code into HA's Guardian Eye integration.
Enter and test the broker connection in GE first. GE and HA must use the same MQTT broker.
Automatic setup follows the MQTT fields; manual settings remain visible.

The component includes its matching panel, registers it automatically and connects GE's video
access without manually entering API addresses, credentials or certificates. Existing layouts and
automations are preserved. The interface uses HA's language.

Follow the [installation guide](docs/INSTALL.md) / [инструкцию на русском](docs/INSTALL.ru.md).
The release includes `guardian-eye-ha-setup.zip` and SHA-256 checksums.

Use the version selected by GE. The compatibility catalog accounts for both GE versions and the
HA contract implemented by each build. Historical `/vVERSION/` links remain immutable; legacy
`/latest/` remains at 1.0.10 for older clients.

For existing dashboard-only HACS installations, this repository remains a **Dashboard** repository.
HACS does not install its Python component or choose a version based on GE. Code-based connection
uses the full package; separate HACS installation is unnecessary.

Sources are exported together by `integrations/HomeAssistant/prepare-release.py` in the GE repository.
`source.json` records the source commit. Run `npm test` and `python3 tools/package.py --output /tmp/ha-packages`
to validate an export. Release CI rejects exports made from uncommitted source changes.
