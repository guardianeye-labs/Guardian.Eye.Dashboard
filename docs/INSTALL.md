# Install Guardian Eye in Home Assistant

[Русский](INSTALL.ru.md)

Use the **compatible package shown by your installed Guardian Eye** under Settings → Home Assistant.
It selects a dashboard and HA component together. Do not substitute the newest dashboard from another
release. The package's `guardian-eye-package.json` records the exact versions and compatibility range.

## 1. Connect MQTT

Install a MQTT broker and configure Home Assistant's MQTT integration to use it. In GE, enable
Home Assistant, enter the same broker details, test the connection and enable Discovery. Save the
settings. Cameras, motion/object sensors, recording mode and control entities appear automatically.
MQTT's integration in HA is a client; it does not install a broker.

## 2. Install the compatible package

1. Download `guardian-eye-ha-setup.zip` using **Download package** in GE.
2. Extract it into Home Assistant's **configuration directory**. On HA OS this is `/config`; with
   Container use the host directory mounted at `/config`. Merge the supplied directories:
   - `custom_components/guardian_eye/`
   - `www/community/guardian-eye-dashboard/`
3. Restart **Home Assistant** to load the Python component.

The archive does not contain `configuration.yaml`, user credentials or `.storage`, and does not
replace your HA configuration. Separate `guardian-eye-dashboard.zip` and `guardian-eye-integration.zip`
are available in the same release for administrators who deploy these directories separately.

## 3. Enable authenticated video in GE

MQTT alone provides sensors and controls. Live video also requires GE's video router and access API.
The listener is disabled by default. Merge this into GE's existing configuration, preserving other
settings and replacing **both example addresses**. HA and the viewing browser must reach GE.

```json
{
  "GuardianEye": {
    "LiveStreaming": {
      "Enabled": true,
      "Access": {
        "Enabled": true,
        "PublicBaseUrl": "http://192.168.1.10:8890",
        "AllowedNetworks": ["192.168.1.20/32", "127.0.0.0/8"]
      },
      "Router": {
        "AllowLanAccess": true,
        "BindAddress": "0.0.0.0",
        "WebRtcPort": 8889,
        "IceUdpPort": 8189
      },
      "Security": {
        "AllowedViewerOrigins": ["http://192.168.1.20:8123"],
        "AdvertisedViewerHosts": ["192.168.1.10"]
      }
    }
  }
}
```

This example is for a trusted LAN with HTTP HA. Permit HA → GE TCP 8890 and browser → GE TCP 8889 /
UDP 8189. Docker's observed source address can be the host address. Use the actual address, not
`localhost` or `0.0.0.0`, for public URLs. Restart GE after changing listener configuration.

For HTTPS HA, configure HTTPS in GE too: use an HTTPS `PublicBaseUrl` and set `Security.Tls.Enabled`,
`CertificatePath` and `PrivateKeyPath` to a certificate/key trusted by HA and the browser. A reverse
proxy, NAT and remote viewing require their own explicit routing; the package does not configure them.

Create a dedicated key in GE's existing access-key settings. `guardian.media.read` is sufficient;
the current key dialog's full-access key also works. In HA open **Settings → Devices & services →
Add integration → Guardian Eye**, enter the GE API URL and key (without the `Bearer ` prefix).
The permanent key stays in HA; the player gets temporary camera access after a HA permission check.

## 4. Create the dashboard

1. In HA open **Settings → Dashboards → Resources** (enable Advanced mode in your HA profile if needed).
2. Add a **JavaScript module** using the **resource URL supplied by GE**. It is pinned to a compatible
   release. For a fully local installation, use
   `/local/community/guardian-eye-dashboard/Guardian.Eye.Dashboard.js?v=VERSION`, replacing `VERSION`
   with the dashboard version shown in GE. Choose one resource URL; do not register both.
3. Refresh the browser, then **Settings → Dashboards → Add dashboard → Guardian Eye**.
4. Open the panel. Camera cards are created from MQTT, without hand-written entity IDs or YAML.

Enable **Capture** on a camera and select Play. Stop viewing closes that browser's video session;
capture and recording continue. Person/Vehicle/Animal sensors require AI mode; Motion uses its
separate sensor. Configure actions in HA's standard automation editor. No example blueprint is installed.
The panel follows the existing HA language; shared default entity names use the owner's HA language.

## Updating and different GE versions

In GE, check for a compatible package again after updating GE. Install **both parts from that package**,
restart HA for Python changes, replace the existing dashboard resource URL and refresh the browser.
Keep the same integration entry, dashboard, camera IDs and automations. Do not create a second resource.
If GE reports no compatible package, keep the installed version and check the release notes.

The catalog selects by the inclusive minimum / exclusive maximum GE release version **and** the HA
contract implemented by that GE build. Prerelease and unversioned development builds require explicit
permission in the catalog. An unknown contract or an unsupported GE version does not fall back to latest.
Historical `/vVERSION/` URLs remain available. The legacy `/latest/` entry stays at 1.0.10 for older GE
clients that cannot negotiate compatibility. New GE clients use `releases.json`.

HACS can install the dashboard from the public Guardian.Eye.Dashboard repository (Dashboard category).
Select the version recommended by GE; HACS does not select by GE version and does not install the Python
component from this dashboard repository. Install that component from the matching package above.

## Verification

Confirm the versions shown in GE, HA's Guardian Eye configuration entry and `guardian-eye-package.json`.
Check MQTT connectivity, one live video, Stop/Play, and a camera control. For missing video, check
capture, GE/API reachability, browser video ports and the Guardian token before changing camera settings.
