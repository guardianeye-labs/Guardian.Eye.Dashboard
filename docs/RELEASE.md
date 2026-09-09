Guardian Eye HA 1.0.23 includes dashboard 1.0.23 and component 1.0.4 for HA 2026.8.3 or newer.

- Connect through one expiring code generated in GE. GE checks the MQTT connection
  already entered by the user, preserves those settings, enables protected video access and creates
  a separate media-read credential. Automatic setup is below the MQTT fields; manual settings remain visible.
- Install one component folder. Its matching panel and HA dashboard register automatically.
- HA proxies authenticated WebRTC signalling, so browsers do not need to trust GE's certificate
  or configure a separate GE origin. WebRTC media still needs network access to GE, such as a VPN
  for remote viewing.
- Reconfiguration preserves the HA entry, camera identities, existing layouts and automations.
- Setup workflow belongs to the GE HomeAssistant feature module; Desktop provides the dialog only.
- Setup and errors are translated into all 18 GE languages using HA's selected language.

This package requires HA contract 3. GE 3.4.x builds implementing contract 2 continue to receive
1.0.22 from the compatibility catalog. Explicit development and prerelease support is retained.

Upgrade by replacing `custom_components/guardian_eye` with the folder from the GE-selected package
and restarting HA. Existing manually configured entries continue working; use Reconfigure with a
new GE code to migrate to automatic protected video setup. A configured MQTT integration is required.
Existing MQTT TLS/CA settings in GE are preserved. HA also retains manual URL/key setup.
