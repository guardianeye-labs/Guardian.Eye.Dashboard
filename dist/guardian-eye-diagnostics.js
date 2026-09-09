// Interpret measurements at the time Guardian published them. With a 60 s publish interval,
// extrapolating a frame's age to wall time would falsely flag every camera between reports.
// Wall time is used only to expire the entire report, never to invent FPS or an AI heartbeat.
export const DEFAULT_STALE_SECONDS = 150;
const FRAME_STALL_SECONDS = 15;
const validState = (entity) => entity && !["unknown", "unavailable"].includes(entity.state);
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const oneOf = (value, options) => options.includes(value) ? value : null;

export function cameraDiagnostics(config, states, now = Date.now()) {
  const ids = config?.diagnostics || {};
  const entity = (key) => states?.[ids[key]];
  const state = (key, options) => validState(entity(key)) ? oneOf(entity(key).state, options) : null;
  const stream = entity("stream");
  const attrs = stream?.attributes || {};
  const capturedAt = timestamp(attrs.captured_at);
  const sampledAt = timestamp(attrs.telemetry_sampled_at);
  const elapsed = capturedAt ? (now - Date.parse(capturedAt)) / 1000 : null;
  const staleAfter = number(config?.diagnostics_stale_seconds) >= 30
    ? config.diagnostics_stale_seconds : DEFAULT_STALE_SECONDS;
  const fresh = Boolean(validState(stream) && elapsed !== null && elapsed >= -5 && elapsed <= staleAfter);
  const modern = attrs.frames_per_second_source === "decoded_frames";
  const workerStale = attrs.telemetry_stale === true || Boolean(capturedAt && sampledAt
    && (Date.parse(capturedAt) - Date.parse(sampledAt)) / 1000 > 30);
  const measurements = {
    captured_at: capturedAt,
    telemetry_sampled_at: sampledAt,
    frames_per_second: modern ? number(attrs.frames_per_second) : null,
    total_decoded_frames: modern ? number(attrs.total_frames_processed) : null,
    decoded_frame_age_seconds: modern ? number(attrs.last_frame_age_seconds) : null,
    video_data_age_seconds: number(attrs.last_video_data_age_seconds),
    preview_frame_age_seconds: number(attrs.last_preview_frame_age_seconds),
    capture_restarts: number(attrs.reconnect_count),
  };
  const power = state("power", ["on", "off"]);
  const mode = state("mode", ["OFF", "ALWAYS", "MOTION", "AI", "ONVIF"]);
  const powerChangedAt = timestamp(entity("power")?.last_changed);
  const awaitingReport = power === "on" && powerChangedAt
    && (!capturedAt || Date.parse(powerChangedAt) > Date.parse(capturedAt))
    && (now - Date.parse(powerChangedAt)) / 1000 < staleAfter;
  let status;
  if (power === "off") status = "off";
  else if (awaitingReport) status = "starting";
  else if (!validState(stream)) status = "unavailable";
  else if (elapsed !== null && elapsed < -5) status = "clock";
  else if (!fresh) status = capturedAt ? "stale" : "unknown";
  else if (power !== "on") status = "unknown";
  else if (attrs.connected === false) status = "disconnected";
  else if (attrs.capturing === false) status = "stopped";
  else if (workerStale) status = "worker_stale";
  else if (measurements.video_data_age_seconds > FRAME_STALL_SECONDS) status = "source_stalled";
  else if (measurements.decoded_frame_age_seconds > FRAME_STALL_SECONDS
    && measurements.frames_per_second === 0) status = "decode_stalled";
  else if (measurements.video_data_age_seconds === null || measurements.decoded_frame_age_seconds === null
    || measurements.frames_per_second === null || !sampledAt
    || attrs.connected !== true || attrs.capturing !== true) status = "unknown";
  else status = "receiving";

  const category = ["disconnected", "stopped", "source_stalled", "decode_stalled"].includes(status)
    ? "problem" : status === "receiving" ? "receiving" : status === "off" ? "off" : "unknown";
  const eventEntity = entity("event");
  const eventAttrs = eventEntity?.attributes || {};
  const eventTypes = ["motion_detected", "motion_ended", "ai_detected", "audio_detected", "tampering_detected",
    "onvif_event", "onvif_motion", "onvif_tampering", "onvif_digital_io", "onvif_analytics", "onvif_audio",
    "camera_connected", "camera_disconnected", "camera_power_changed", "recording_state_changed",
    "recording_mode_changed", "camera_added", "camera_updated", "camera_removed", "object_trail_updated",
    "zone_dwell_exceeded", "object_classification_refined"];
  // Only explicit, bounded fields may reach the report. Never serialize a HA entity/attributes object:
  // it can contain snapshot URLs, local recording paths or future authentication attributes.
  const lastEvent = validState(eventEntity) && timestamp(eventEntity.state) ? {
    event_type: oneOf(eventAttrs.event_type, eventTypes),
    event_id: /^[a-zA-Z0-9-]{1,64}$/.test(eventAttrs.event_id || "") ? eventAttrs.event_id : null,
    observed_in_ha_at: timestamp(eventEntity.state),
    occurred_at: timestamp(eventAttrs.occurred_at),
  } : null;
  const objectStates = Object.values(config?.object_entities || {}).map(id => states?.[id]);
  const objectState = objectStates.find(validState);
  const analyzedAt = timestamp(objectState?.attributes?.analyzed_frame_at);
  const analysisAge = analyzedAt ? (now - Date.parse(analyzedAt)) / 1000 : null;
  const analysis = {
    analyzed_at: analyzedAt,
    fresh: power === "on" && mode === "AI" && analysisAge !== null && analysisAge >= -2 && analysisAge < 15,
    reported: objectStates.some(item => item?.attributes?.source === "local_ai"),
  };
  return { status, category, fresh, workerStale, power, mode, measurements, lastEvent,
    analysis,
    motion: state("motion", ["on", "off"]), recording: state("recording", ["on", "off"]),
    staleAfter };
}

export function diagnosticsReport(config, states, now = Date.now()) {
  const model = cameraDiagnostics(config, states, now);
  return {
    schema_version: 1, generated_at: new Date(now).toISOString(),
    camera_id: /^[0-9a-f-]{36}$/i.test(config?.camera_id || "") ? config.camera_id : null,
    ...model,
    limitations: ["Measurements describe the published report, not continuous monitoring.",
      model.analysis.reported ? "Analysis freshness covers local AI only; motion processing has no heartbeat."
        : "No detector processing heartbeat is available.",
      "A HA event does not confirm recording file creation or automation completion.",
      "Capture restarts are process epochs, not all RTSP retry attempts."],
  };
}

export const DIAGNOSTIC_STATUS = {
  off: ["HADiagOff", "Capture is off"],
  starting: ["HADiagStarting", "Waiting for a report after starting capture"],
  unavailable: ["HADiagUnavailable", "Telemetry unavailable in HA"],
  clock: ["HADiagClock", "Check the Guardian and browser clocks"],
  stale: ["HADiagStale", "Telemetry is out of date"],
  unknown: ["HADiagUnknown", "Not enough measurements"],
  disconnected: ["HADiagDisconnected", "Camera disconnected at last check"],
  stopped: ["HADiagStopped", "Capture stopped while enabled"],
  worker_stale: ["HADiagWorkerStale", "No fresh report from the camera process"],
  source_stalled: ["HADiagSourceStalled", "No recent video data at last check"],
  decode_stalled: ["HADiagDecodeStalled", "Decoding stalled at last check"],
  receiving: ["HADiagReceiving", "Video frames received at last check"],
};

export function nvrDiagnostics(entities, states, now = Date.now(), staleAfter = DEFAULT_STALE_SECONDS) {
  staleAfter = number(staleAfter) >= 30 ? staleAfter : DEFAULT_STALE_SECONDS;
  const statusEntity = states?.[entities.status];
  const capturedAt = timestamp(statusEntity?.attributes?.captured_at);
  const elapsed = capturedAt ? (now - Date.parse(capturedAt)) / 1000 : null;
  const status = validState(statusEntity)
    ? oneOf(statusEntity.attributes?.status, ["ready", "degraded", "failed"]) : null;
  const fresh = elapsed !== null && elapsed >= -5 && elapsed <= staleAfter;
  const values = Object.fromEntries(["pending", "retries", "storage"].map(key => {
    const entity = states?.[entities[key]];
    return [key, validState(entity) && String(entity.state).trim() !== "" ? number(Number(entity.state)) : null];
  }));
  return { status, fresh, capturedAt, ...values };
}
