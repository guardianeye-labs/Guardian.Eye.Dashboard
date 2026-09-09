const CAMERA_MODEL = "Video Surveillance Camera";
const NVR_MODEL = "Network Video Recorder";
const MANUFACTURER = "Guardian Eye";

function entityFor(entities, deviceId, uniqueIdSuffix) {
  return entities.find((entity) =>
    entity.platform === "mqtt"
    && !entity.disabled_by
    && entity.device_id === deviceId
    && String(entity.unique_id || "").endsWith(uniqueIdSuffix))?.entity_id;
}

function entityRows(entityIds) {
  return entityIds.filter(Boolean).map((entity) => ({ entity }));
}

function actionButton(entity, icon) {
  return {
    entity,
    icon,
    show_name: false,
    tap_action: {
      action: "perform-action",
      perform_action: "button.press",
      target: { entity_id: entity },
    },
  };
}

function ptzRows(entities, deviceId) {
  const left = entityFor(entities, deviceId, "_ptz_left");
  const definitions = left
    ? [
        [left, "mdi:arrow-left"],
        [entityFor(entities, deviceId, "_ptz_up"), "mdi:arrow-up"],
        [entityFor(entities, deviceId, "_ptz_stop"), "mdi:stop-circle-outline"],
        [entityFor(entities, deviceId, "_ptz_down"), "mdi:arrow-down"],
        [entityFor(entities, deviceId, "_ptz_right"), "mdi:arrow-right"],
      ]
    : [
        [entityFor(entities, deviceId, "_ptz_zoom_out"), "mdi:magnify-minus"],
        [entityFor(entities, deviceId, "_ptz_home"), "mdi:home"],
        [entityFor(entities, deviceId, "_ptz_stop"), "mdi:stop-circle-outline"],
        [entityFor(entities, deviceId, "_ptz_zoom_in"), "mdi:magnify-plus"],
      ];
  const buttons = definitions
    .filter(([entity]) => entity)
    .map(([entity, icon]) => actionButton(entity, icon));
  return buttons.length ? [{ type: "buttons", entities: buttons }] : [];
}

function imagingRows(entities, deviceId) {
  const definitions = [
    [entityFor(entities, deviceId, "_brightness"), "mdi:brightness-6"],
    [entityFor(entities, deviceId, "_contrast"), "mdi:contrast-circle"],
    [entityFor(entities, deviceId, "_saturation"), "mdi:palette"],
    [entityFor(entities, deviceId, "_sharpness"), "mdi:image-filter-center-focus"],
  ];
  const buttons = definitions
    .filter(([entity]) => entity)
    .map(([entity, icon]) => ({
      entity,
      icon,
      show_name: false,
      tap_action: { action: "more-info" },
    }));
  return buttons.length ? [{ type: "buttons", entities: buttons }] : [];
}

function compactTitle(title) {
  if (title.length <= 21) return title;
  const withoutIp = title.replace(/ \d+(?:\.\d+){3}$/, "");
  return withoutIp.length <= 21 ? withoutIp : `${withoutIp.slice(0, 20)}…`;
}

export function guardianCameraDevices(devices, entities) {
  return devices
    .filter((device) =>
      device.manufacturer === MANUFACTURER && device.model === CAMERA_MODEL
      && entities.some((entity) => entity.platform === "mqtt" && entity.device_id === device.id))
    .sort((left, right) => {
      const leftName = left.name_by_user || left.name || "";
      const rightName = right.name_by_user || right.name || "";
      return leftName.localeCompare(rightName);
    });
}

export function cameraConfig(device, entities) {
  const deviceId = device.id;
  const title = device.name_by_user || device.name || "Camera";
  const recordingMode = entityFor(entities, deviceId, "_recording_mode");
  // HA can keep devices from different integrations separate. Correlate their stable camera identity,
  // never their display name or entity_id (both can be renamed by the user).
  const cameraId = entities.filter((entity) => entity.platform === "mqtt" && entity.device_id === deviceId)
    .map((entity) => /^guardian_eye_([0-9a-f-]{36})_/i.exec(entity.unique_id || "")?.[1]?.toLowerCase())
    .find(Boolean);
  const viewers = cameraId ? entities.filter((entity) => entity.platform === "guardian_eye"
    && !entity.disabled_by && entity.entity_id.startsWith("camera.")
    && String(entity.unique_id || "").toLowerCase().endsWith(`_${cameraId}_live_viewer`)) : [];
  // Multiple Guardian connections for the same camera are ambiguous; never choose an arbitrary server.
  const liveCamera = viewers.length === 1 ? viewers[0].entity_id : undefined;
  return {
    title: compactTitle(title),
    full_title: title,
    image_entity: entityFor(entities, deviceId, "_snapshot"),
    live_entity: entityFor(entities, deviceId, "_live"),
    ai_entity: entityFor(entities, deviceId, "_ai_detection"),
    live_camera_entity: liveCamera,
    live: Boolean(liveCamera),
    camera_id: cameraId,
    diagnostics: Object.fromEntries(Object.entries({
      stream: "_stream", power: "_power", mode: "_recording_mode",
      motion: "_motion", recording: "_recording_state", event: "_event",
    }).map(([key, suffix]) => [key, entityFor(entities, deviceId, suffix)])
      .filter(([, id]) => id)),
    recording_mode_entity: recordingMode,
    object_entities: Object.fromEntries(["person", "vehicle", "animal"]
      .map((group) => [group, entityFor(entities, deviceId, `_${group}`)])
      .filter(([, id]) => id)),
    entities: [
      ...ptzRows(entities, deviceId),
      ...imagingRows(entities, deviceId),
      ...entityRows([
        entityFor(entities, deviceId, "_stream"),
        entityFor(entities, deviceId, "_motion"),
        entityFor(entities, deviceId, "_ai_detection"),
        entityFor(entities, deviceId, "_person"),
        entityFor(entities, deviceId, "_vehicle"),
        entityFor(entities, deviceId, "_animal"),
        entityFor(entities, deviceId, "_recording_state"),
      ]),
      ...(recordingMode ? [{ entity: recordingMode, name: "" }] : []),
      ...entityRows([entityFor(entities, deviceId, "_power")]),
    ],
  };
}

export function nvrConfig(devices, entities) {
  const device = devices.find((candidate) =>
    candidate.manufacturer === MANUFACTURER && candidate.model === NVR_MODEL);
  if (!device) return {};
  const suffixes = {
    status: "_status",
    cameras: "_cameras_online",
    recordings: "_active_recordings",
    pending: "_pending_events",
    retries: "_delivery_retries",
    cpu: "_cpu",
    gpu: "_gpu",
    storage: "_storage",
    memory: "_memory",
    memoryLimit: "_memory_limit",
    inference: "_ai_inference",
  };
  return {
    entities: Object.fromEntries(Object.entries(suffixes)
      .map(([key, suffix]) => [key, entityFor(entities, device.id, suffix)])
      .filter(([, entity]) => entity)),
  };
}
