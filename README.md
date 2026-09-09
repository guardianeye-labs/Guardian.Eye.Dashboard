# Guardian Eye for Home Assistant

![Guardian Eye dashboard](docs/guardian-eye.png)

Camera dashboard, authenticated live viewing, MQTT sensors and camera controls.

Start in **Guardian Eye → Settings → Home Assistant → Check for update**. GE selects a compatible
pair of dashboard and Python component versions. Download that package and follow the
[installation guide](docs/INSTALL.md) / [инструкцию на русском](docs/INSTALL.ru.md).

A release provides `guardian-eye-ha-setup.zip` with both parts, separate dashboard and integration
ZIPs, and SHA-256 checksums. MQTT creates cameras and sensors automatically; the Python component
checks HA permissions and brokers temporary video access. There is no extra language selector.

**Compatibility matters.** Use the version selected by GE rather than blindly installing the newest
HACS release. Historical `/vVERSION/` links remain immutable. Legacy `/latest/` remains at 1.0.10 for
older GE clients; current GE selects from the version ranges and contract revisions in `releases.json`.

For HACS, add `https://github.com/guardianeye-labs/Guardian.Eye.Dashboard` as a **Dashboard** repository.
Install the GE-recommended dashboard version, then install the component from the matching package.
HACS installs the modules and locales from `dist`, with `Guardian.Eye.Dashboard.js` as the entry point.

Sources are exported together from the Guardian Eye repository by `integrations/HomeAssistant/prepare-release.py`.
`source.json` records the source commit. Run `npm test` and `python3 tools/package.py --output /tmp/ha-packages`
to validate and package an export. Release CI rejects an export made from uncommitted source changes.
