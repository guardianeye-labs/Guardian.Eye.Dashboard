Guardian Eye HA 1.0.22 pairs dashboard 1.0.22 with component 1.0.3 for HA 2026.8.3 or newer.

- Authenticated video, Stop/Cancel controls and a compact PTZ row that does not wrap.
- Camera diagnostics, fresh AI object sensors, device deduplication and all 18 GE languages.
- One installation ZIP with both parts, separate ZIPs and SHA-256 checksums.
- A compatibility catalog for GE 3.4.x builds implementing HA contract 2. Development/prerelease
  builds of that contract are allowed explicitly. Older GE keeps its existing 1.0.10 entry point.

Use the package selected in GE's Home Assistant settings. Install both parts, restart HA for the
Python component, update the existing dashboard resource URL and refresh the browser.

See the versioned installation guide included in each archive. Configure the GE live listener and
access key for video; these are not provisioned by extracting the archive. HACS installs only the
dashboard from this repository and does not select its version based on GE.
