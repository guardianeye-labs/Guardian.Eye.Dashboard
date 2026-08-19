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
assert.match(cameraCardSource, /#states > div:has\(> hui-buttons-row\) \{ margin-block: 2px 4px; \}/);

const dashboardCardSource = await import("node:fs/promises")
  .then(({ readFile }) => readFile(new URL("../dist/guardian-eye-dashboard.js", import.meta.url), "utf8"));
assert.match(dashboardCardSource, /--ha-color-form-background:\s*#101a2e/);
assert.match(dashboardCardSource, /--ha-color-form-background-disabled:\s*#111827/);

const nvrCardSource = await import("node:fs/promises")
  .then(({ readFile }) => readFile(new URL("../dist/guardian-eye-nvr-card.js", import.meta.url), "utf8"));
assert.match(nvrCardSource, /\.gauges > \* \{ display: block; height: clamp\(150px, 14vw, 190px\); \}/);
assert.match(nvrCardSource, /tap_action: \{ action: "more-info" \}/);
assert.match(nvrCardSource, /new CustomEvent\("hass-more-info"/);
