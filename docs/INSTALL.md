# Connect Guardian Eye to Home Assistant

[Русский](INSTALL.ru.md)

## Install once

Home Assistant needs a configured **MQTT integration** and an MQTT broker reachable from GE.
If they are missing, install a broker (such as Mosquitto) and add MQTT to HA first.

1. In GE, open **Settings → Smart Home → Home Assistant** and download the suggested package.
2. Copy `custom_components/guardian_eye` from `guardian-eye-ha-setup.zip` into HA's configuration
   directory, usually `/config/custom_components/guardian_eye`. On upgrade, replace this folder
   entirely, keeping the rest of your HA configuration.
3. Restart Home Assistant.

The component includes its matching dashboard. No separate `www` files, JavaScript resource
registration or YAML is needed.

## Connect using a code

Enter the MQTT server, port and credentials in GE and test the connection. GE and HA must use
the same broker. Automatic setup appears below the MQTT settings.

1. In GE, click **Connect Home Assistant**, copy the code and leave the dialog open.
2. In HA, open **Settings → Devices & services → Add integration → Guardian Eye**, choose the code connection, paste the code
   and finish adding the integration.

The code lasts five minutes. If GE offers several network addresses, choose the network that HA
can reach. Devices and sensors appear automatically, with **Guardian Eye** in HA's sidebar.
Refresh the browser if it was already open.

GE verifies the MQTT settings already entered in GE, enables video access and creates a separate
viewing credential. Existing broker settings, credentials, TLS and discovery prefix are preserved.
The permanent video credential stays on the HA backend; camera access is checked against the HA
user’s permissions. The interface uses HA’s language setting.

## Use

Enable the camera's **Capture** switch and start viewing. **Stop viewing** closes video in the
current browser; capture and recording continue. Person, vehicle and animal sensors require AI
detection. Motion has its own sensor. Assign actions in HA's normal automation editor. No example
automations are installed automatically.

## Update or reconnect

GE selects a package compatible with its installed build. Download it, replace only
`custom_components/guardian_eye`, restart HA and refresh the browser. The dashboard updates with
the component. Existing layouts, identities and automations are preserved.

To replace GE access, create a new code and select **Reconfigure** on the existing Guardian Eye
integration. Do not delete the entry. When migrating from manual configuration, do this once to
establish protected access. The previous dashboard resource is updated automatically.

Different GE versions may need different packages. Use the package GE suggests; keep your installed
version if no compatible release is available. `guardian-eye-package.json` in the archive records
the versions. Historical releases and their URLs remain available.

## Troubleshooting

- **MQTT is missing:** configure MQTT in HA. Installing Guardian Eye does not install a broker.
- **Broker unreachable:** make its port reachable from the GE computer. Mosquitto on HA OS needs
  its broker port exposed on the HA host's address.
- **Invalid or expired code:** create a new code in GE. Check both machines' clocks.
- **Incompatible version:** install the package suggested by your GE build.
- **No video:** check camera capture and network access to GE.

GE and the HA server must be able to reach each other. HA contacts the temporary HTTPS port in
the code, then GE's API (TCP 8890 by default). Browser signalling travels through HA; WebRTC media
travels directly from GE (UDP 8189 by default). Viewing from another network requires a route to
GE, such as a VPN. The package does not configure NAT or a VPN.

TLS and CA settings come from GE’s existing MQTT configuration. Manual settings remain visible.
HA also offers manual entry of the GE address and access key.

The Guardian.Eye.Dashboard HACS repository is in the Dashboard category and installs only the
panel. For code-based connection, use the complete package from GE; an additional HACS panel
installation is unnecessary.
