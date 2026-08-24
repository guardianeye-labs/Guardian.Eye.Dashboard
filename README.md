# Guardian Eye Dashboard

![Guardian Eye](docs/guardian-eye.png)

A dynamic Home Assistant dashboard for Guardian Eye NVR telemetry, cameras,
events and controls. The dashboard discovers Guardian Eye devices from the Home
Assistant MQTT device and entity registries, so camera entity IDs do not need to
be maintained manually.

## Requirements

- Home Assistant 2026.5 or newer;
- HACS;
- Guardian Eye connected to the same MQTT broker as Home Assistant;
- MQTT Discovery and Home Assistant publishing enabled in Guardian Eye.

## Install with HACS

Until the dashboard is included in the default HACS catalog, add it as a custom
repository:

1. Open **HACS** in Home Assistant.
2. Open the three-dot menu and select **Custom repositories**.
3. Add this repository URL and select the **Dashboard** category.
4. Download **Guardian Eye Dashboard**.
5. Reload the Home Assistant frontend when HACS asks for it.
6. Open **Settings → Dashboards → Add dashboard**.
7. Select **Guardian Eye** under **Community dashboards** and create it.

No dashboard YAML or manual camera cards are required.

## Optional global theme

The JavaScript resource styles the Guardian Eye dashboard itself. Home Assistant global themes
are server-side files and cannot be registered by a dashboard JavaScript module. To style the
Home Assistant sidebar and dialogs as well:

1. Download
   [`GuardianEyeTheme.yaml`](https://guardianeye-labs.github.io/Guardian.Eye.Dashboard/v1.0.9/GuardianEyeTheme.yaml).
2. Place it at `/config/themes/GuardianEyeTheme.yaml`.
3. Confirm that `configuration.yaml` contains:

   ```yaml
   frontend:
     themes: !include_dir_merge_named themes
   ```

4. Reload themes or restart Home Assistant, then select **Guardian Eye** in the user profile.

## Updating

Install the new version from HACS and reload the Home Assistant frontend. The
dashboard layout is generated from the current MQTT registries, so camera
additions and removals do not require reinstalling the dashboard.

## Development

Run the package tests with:

```bash
npm test
```

The public HACS entry point is `dist/Guardian.Eye.Dashboard.js`. Implementation
modules and localization files are kept in `dist` so HACS installs them as one
dashboard package.

## License

MIT
