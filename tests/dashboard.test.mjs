import assert from "node:assert/strict";

globalThis.HTMLElement = class {};
globalThis.window = globalThis;
globalThis.window.customCards = [];
globalThis.window.customStrategies = [];

const elements = new Map();
globalThis.customElements = {
  define(name, definition) {
    elements.set(name, definition);
  },
  get(name) {
    return elements.get(name);
  },
};

const {
  cameraConfig,
  nvrConfig,
} = await import("../dist/guardian-eye-dashboard-config.js");
const { GuardianEyeDashboardStrategy } =
  await import("../dist/Guardian.Eye.Dashboard.js");

const camera = {
  id: "camera-device",
  manufacturer: "Guardian Eye",
  model: "Video Surveillance Camera",
  name: "Front Door 192.168.1.10",
};
const nvr = {
  id: "nvr-device",
  manufacturer: "Guardian Eye",
  model: "Network Video Recorder",
  name: "Guardian Eye NVR",
};
const entity = (deviceId, uniqueId, entityId) => ({
  device_id: deviceId,
  entity_id: entityId,
  platform: "mqtt",
  unique_id: uniqueId,
});
const entities = [
  entity("camera-device", "guardian_camera_stream", "binary_sensor.front_stream"),
  entity("camera-device", "guardian_camera_motion", "binary_sensor.front_motion"),
  entity("camera-device", "guardian_camera_ai_detection", "sensor.front_ai"),
  entity("camera-device", "guardian_camera_recording_state", "binary_sensor.front_recording"),
  entity("camera-device", "guardian_camera_recording_mode", "select.front_mode"),
  entity("camera-device", "guardian_camera_power", "switch.front_power"),
  entity("camera-device", "guardian_camera_snapshot", "image.front_snapshot"),
  entity("camera-device", "guardian_camera_ptz_zoom_out", "button.front_zoom_out"),
  entity("camera-device", "guardian_camera_ptz_home", "button.front_home"),
  entity("camera-device", "guardian_camera_ptz_stop", "button.front_stop"),
  entity("camera-device", "guardian_camera_ptz_zoom_in", "button.front_zoom_in"),
  entity("nvr-device", "guardian_eye_nvr_status", "sensor.renamed_status"),
  entity("nvr-device", "guardian_eye_nvr_storage", "sensor.renamed_storage"),
];

const config = cameraConfig(camera, entities);
assert.equal(config.title, "Front Door");
assert.equal(config.image_entity, "image.front_snapshot");
assert.deepEqual(
  config.entities[0].entities.map((button) => button.entity),
  ["button.front_zoom_out", "button.front_home", "button.front_stop", "button.front_zoom_in"],
);
assert.ok(config.entities.some((row) => row.entity === "select.front_mode" && row.name === ""));
assert.equal(config.entities.at(-1).entity, "switch.front_power");

const telemetry = nvrConfig([camera, nvr], entities);
assert.equal(telemetry.entities.status, "sensor.renamed_status");
assert.equal(telemetry.entities.storage, "sensor.renamed_storage");

const dashboard = await GuardianEyeDashboardStrategy.generate({ title: "My NVR" });
assert.equal(dashboard.title, "My NVR");
assert.equal(dashboard.views[0].type, "panel");
assert.equal(dashboard.views[0].cards[0].type, "custom:guardian-eye-dashboard-card");
assert.ok(window.customStrategies.some((strategy) =>
  strategy.type === "guardian-eye" && strategy.strategyType === "dashboard"));

const cameraCardSource = await import("node:fs/promises")
  .then(({ readFile }) => readFile(new URL("../dist/guardian-eye-camera-card.js", import.meta.url), "utf8"));
assert.match(cameraCardSource, /--md-list-item-one-line-container-height:\s*36px/);
assert.match(cameraCardSource, /ha-color-form-background-disabled/);
assert.match(cameraCardSource, /md-list-item-label-text-color/);
assert.match(cameraCardSource, /ha-dropdown-item\[selected\]/);
assert.match(cameraCardSource, /background-color:\s*#101a2e !important/);
assert.match(cameraCardSource, /\.card-content \{ padding: 6px 9px 10px !important; \}/);
assert.match(cameraCardSource, /#states > div:has\(> hui-buttons-row\) \{ margin-block: 3px 7px; \}/);
assert.match(cameraCardSource, /border:\s*1px solid var\(--guardian-eye-accent, #00d4ff\)/);

const iconSource = await import("node:fs/promises")
  .then(({ readFile }) => readFile(new URL("../dist/guardian-eye-icons.js", import.meta.url), "utf8"));
assert.match(iconSource, /window\.customIcons\[ICON_SET\] = \{ getIcon, getIconList \}/);
assert.deepEqual(
  await window.customIconsets["guardian-eye"]("logo"),
  {
    path: "M12 1 21 4v6c0 6.2-3.8 10.7-9 13-5.2-2.3-9-6.8-9-13V4l9-3Zm6 9a6 6 0 1 0-12 0 6 6 0 1 0 12 0Zm-3.8 0a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 1 1 4.4 0Z",
    viewBox: "0 0 24 24",
  },
);
assert.deepEqual(
  await window.customIcons["guardian-eye"].getIconList(),
  [{ name: "logo", keywords: [] }],
);

const { refreshGuardianEyeIcons } = await import("../dist/guardian-eye-icons.js");
const assignments = [];
const renderedIcon = {
  localName: "ha-icon",
  get icon() { return this._icon; },
  set icon(value) { this._icon = value; assignments.push(value); },
  _icon: "guardian-eye:logo",
  updateComplete: Promise.resolve(),
};
const nestedRoot = { querySelectorAll: () => [renderedIcon] };
const documentRoot = {
  querySelectorAll: () => [{ localName: "ha-sidebar", shadowRoot: nestedRoot }],
};
await refreshGuardianEyeIcons(documentRoot);
assert.deepEqual(assignments, ["mdi:cctv", "guardian-eye:logo"]);

const dashboardCardSource = await import("node:fs/promises")
  .then(({ readFile }) => readFile(new URL("../dist/guardian-eye-dashboard.js", import.meta.url), "utf8"));
assert.match(dashboardCardSource, /--ha-color-form-background:\s*#101a2e/);
assert.match(dashboardCardSource, /--ha-color-form-background-disabled:\s*#111827/);

const nvrCardSource = await import("node:fs/promises")
  .then(({ readFile }) => readFile(new URL("../dist/guardian-eye-nvr-card.js", import.meta.url), "utf8"));
assert.match(nvrCardSource, /\.gauges > \* \{ display: block; height: clamp\(150px, 14vw, 190px\); \}/);
assert.match(nvrCardSource, /tap_action: \{ action: "more-info" \}/);
assert.match(nvrCardSource, /new CustomEvent\("hass-more-info"/);
