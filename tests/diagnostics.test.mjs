import assert from "node:assert/strict";
import test from "node:test";
import { cameraDiagnostics, diagnosticsReport, nvrDiagnostics } from "../dist/guardian-eye-diagnostics.js";

const now = Date.parse("2026-09-08T12:00:00Z");
const config = { camera_id: "11111111-2222-3333-4444-555555555555", diagnostics: {
  power: "switch.power", stream: "binary_sensor.stream", mode: "select.mode",
  event: "event.camera", motion: "binary_sensor.motion", recording: "binary_sensor.recording",
} };
const iso = seconds => new Date(now + seconds * 1000).toISOString();
function fixture() {
  return {
    "switch.power": { state: "on", last_changed: iso(-1000) },
    "select.mode": { state: "AI" },
    "binary_sensor.stream": { state: "on", attributes: {
      captured_at: iso(0), telemetry_sampled_at: iso(-1), telemetry_stale: false,
      connected: true, capturing: true, frames_per_second_source: "decoded_frames",
      frames_per_second: 15, total_frames_processed: 900, last_frame_age_seconds: 0.2,
      last_video_data_age_seconds: 0.1, last_preview_frame_age_seconds: 0.3, reconnect_count: 2,
    } },
    "binary_sensor.motion": { state: "off" }, "binary_sensor.recording": { state: "off" },
  };
}
const diag = (states, at = now) => cameraDiagnostics(config, states, at);

test("object analysis confirms healthy AI on empty frames and expires independently of video", () => {
  const cfg = { ...config, object_entities: { person: "binary_sensor.person" } };
  const states = fixture();
  states["binary_sensor.person"] = { state: "off", attributes: { source: "local_ai", analyzed_frame_at: iso(-1) } };
  assert.equal(cameraDiagnostics(cfg, states, now).analysis.fresh, true);
  assert.equal(cameraDiagnostics(cfg, states, now + 15000).analysis.fresh, false);
  states["binary_sensor.person"].state = "unavailable";
  assert.equal(cameraDiagnostics(cfg, states, now).analysis.fresh, false);
  assert.equal(cameraDiagnostics(cfg, states, now).analysis.reported, true);
});

test("60 s telemetry interval does not turn a healthy stream into a frame stall", () => {
  for (const seconds of [0, 30, 59, 100, 149]) {
    const model = diag(fixture(), now + seconds * 1000);
    assert.equal(model.status, "receiving");
    assert.equal(model.measurements.decoded_frame_age_seconds, 0.2);
  }
  assert.equal(diag(fixture(), now + 151_000).status, "stale");
});

test("closed preview and no objects are not a capture or AI failure", () => {
  const states = fixture();
  states[config.diagnostics.stream].attributes.last_preview_frame_age_seconds = 500;
  const model = diag(states);
  assert.equal(model.status, "receiving");
  assert.equal(model.lastEvent, null);
  assert.equal(model.motion, "off");
  assert.equal(model.recording, "off");
  assert.equal(model.mode, "AI");
});

test("disabled cameras remain separate from failed or unconfirmed cameras", () => {
  const states = fixture();
  states[config.diagnostics.power].state = "off";
  states[config.diagnostics.stream].state = "unavailable";
  assert.equal(diag(states).category, "off");
  assert.equal(diag({}).category, "unknown");
});

test("offline camera, stopped capture, input stall and decode stall have distinct explanations", () => {
  for (const [patch, status] of [
    [{ connected: false }, "disconnected"],
    [{ capturing: false }, "stopped"],
    [{ last_video_data_age_seconds: 20, last_frame_age_seconds: 20, frames_per_second: 0 }, "source_stalled"],
    [{ last_frame_age_seconds: 20, frames_per_second: 0 }, "decode_stalled"],
  ]) {
    const states = fixture();
    Object.assign(states[config.diagnostics.stream].attributes, patch);
    assert.equal(diag(states).status, status);
    assert.equal(diag(states).category, "problem");
  }
});

test("old worker or disconnected HA telemetry cannot be presented as current measurements", () => {
  const states = fixture();
  states[config.diagnostics.stream].attributes.telemetry_sampled_at = iso(-45);
  assert.equal(diag(states).status, "worker_stale");
  states[config.diagnostics.stream].state = "unavailable";
  assert.equal(diag(states).status, "unavailable");
  assert.equal(diag(states).fresh, false);
});

test("unknown, legacy preview metrics and invalid numbers never become zero or healthy", () => {
  for (const value of [undefined, null, "15", NaN, Infinity, -1]) {
    const states = fixture();
    states[config.diagnostics.stream].attributes.frames_per_second = value;
    assert.equal(diag(states).measurements.frames_per_second, null);
    assert.equal(diag(states).category, "unknown");
  }
  const states = fixture();
  delete states[config.diagnostics.stream].attributes.frames_per_second_source;
  assert.equal(diag(states).measurements.decoded_frame_age_seconds, null);
  assert.equal(diag(states).category, "unknown");
});

test("an observed zero FPS is preserved without claiming a stall from one sampling window", () => {
  const states = fixture();
  states[config.diagnostics.stream].attributes.frames_per_second = 0;
  assert.equal(diag(states).measurements.frames_per_second, 0);
  assert.notEqual(diag(states).category, "problem");
});

test("power-on waits for a newer report, then expires rather than waiting indefinitely", () => {
  const states = fixture();
  states[config.diagnostics.power].last_changed = iso(1);
  states[config.diagnostics.stream].attributes.connected = false;
  assert.equal(diag(states, now + 2000).status, "starting");
  assert.equal(diag(states, now + 152_000).status, "stale");
  states[config.diagnostics.stream].attributes.captured_at = iso(2);
  assert.equal(diag(states, now + 2000).status, "disconnected");
});

test("clock skew and a configurable publication interval are explicit", () => {
  assert.equal(diag(fixture(), now - 10_000).status, "clock");
  assert.equal(cameraDiagnostics({ ...config, diagnostics_stale_seconds: 700 }, fixture(), now + 600_000).status, "receiving");
});

test("report exports only known fields, not credentials, recording paths or complete event attributes", () => {
  const states = fixture();
  states[config.diagnostics.stream].attributes.token = "secret-token";
  states[config.diagnostics.event] = { state: iso(-2), attributes: {
    event_type: "ai_detected", event_id: "01a07f9881057d7da8f891b422e1df93", occurred_at: iso(-4),
    received_at: iso(-3), recording_path: "/private/recordings/private.mp4",
    snapshot_url: "http://user:password@example.invalid/image", objects: [{ class: "secret-token" }],
  } };
  const report = diagnosticsReport(config, states, now);
  assert.equal(report.lastEvent.observed_in_ha_at, iso(-2));
  assert.equal(report.lastEvent.occurred_at, iso(-4));
  assert.equal(report.lastEvent.event_type, "ai_detected");
  assert.doesNotMatch(JSON.stringify(report), /secret-token|password|private.mp4|snapshot_url|received_at/);
  states[config.diagnostics.event].state = "unavailable";
  assert.equal(diag(states).lastEvent, null);
});

test("missing NVR values and retained ready attributes on an unavailable entity do not mean healthy", () => {
  const entities = { status: "sensor.status", pending: "sensor.pending", retries: "sensor.retries", storage: "sensor.storage" };
  const states = {
    "sensor.status": { state: "ready", attributes: { status: "ready", captured_at: iso(0) } },
    "sensor.pending": { state: "0" }, "sensor.retries": { state: "unknown" },
    "sensor.storage": { state: "85" },
  };
  let model = nvrDiagnostics(entities, states, now);
  assert.equal(model.pending, 0);
  assert.equal(model.retries, null);
  assert.equal(model.storage, 85);
  assert.equal(nvrDiagnostics(entities, states, now + 151_000).fresh, false);
  states[entities.status].state = "unavailable";
  model = nvrDiagnostics(entities, states, now);
  assert.equal(model.status, null);
});
