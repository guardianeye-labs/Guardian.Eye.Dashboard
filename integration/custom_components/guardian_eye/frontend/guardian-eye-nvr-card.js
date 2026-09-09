import {
  homeAssistantLanguage,
  loadGuardianEyeTranslations,
  translate,
} from "./guardian-eye-localization.js?v=1.0.23";
import { nvrDiagnostics } from "./guardian-eye-diagnostics.js?v=1.0.23";

const CARD_TAG = "guardian-eye-nvr-card";
const DEFAULT_ENTITIES = {
  status: "sensor.guardian_eye_nvr_status",
  cameras: "sensor.guardian_eye_nvr_cameras_online",
  recordings: "sensor.guardian_eye_nvr_active_recordings",
  pending: "sensor.guardian_eye_nvr_pending_events",
  retries: "sensor.guardian_eye_nvr_delivery_retries",
  cpu: "sensor.guardian_eye_nvr_cpu",
  gpu: "sensor.guardian_eye_nvr_gpu",
  storage: "sensor.guardian_eye_nvr_storage_used",
  memory: "sensor.guardian_eye_nvr_memory",
  memoryLimit: "sensor.guardian_eye_nvr_memory_limit",
  inference: "sensor.guardian_eye_nvr_ai_inference",
};

class GuardianEyeNvrCard extends HTMLElement {
  constructor() {
    super();
    this._entities = { ...DEFAULT_ENTITIES };
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    this._config = config || {};
    this._entities = { ...DEFAULT_ENTITIES, ...(this._config.entities || {}) };
    this._gauges = [];
    this._renderShell();
    if (this._hass) {
      void this._renderGauges();
      this._updateValues();
    }
  }

  set hass(value) {
    this._hass = value;
    const language = homeAssistantLanguage(value);
    if (language !== this._language) {
      this._language = language;
      this._translations = {};
      void this._loadTranslations(language);
      void this._renderGauges();
    }
    for (const gauge of this._gauges || []) {
      gauge.hass = value;
    }
    this._updateValues();
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .metrics, .gauges { display: grid; gap: 8px; margin-bottom: 8px; }
        .metrics.primary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .metrics.secondary, .gauges { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .gauges > * { display: block; height: clamp(150px, 14vw, 190px); }
        ha-card.metric { box-sizing: border-box; min-height: 70px; padding: 12px 16px; }
        ha-card.metric.action { cursor: pointer; }
        ha-card.metric.action:focus-visible { outline: 2px solid var(--primary-color); }
        .label { color: var(--secondary-text-color); font-size: 0.82rem; font-weight: 600; }
        .value { color: var(--primary-text-color); font-size: 1rem; margin-top: 5px; }
        ha-card.health { padding: 16px; }
        .issue { margin-top: 6px; }
        @media (max-width: 760px) {
          .metrics.primary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .metrics.secondary, .gauges { grid-template-columns: 1fr; }
          .gauges > * { height: 160px; }
        }
      </style>
      <div class="metrics primary"></div>
      <div class="gauges"></div>
      <div class="metrics secondary"></div>
      <ha-card class="health"><div class="health-content"></div></ha-card>`;
    this._renderMetrics();
  }

  async _loadTranslations(language) {
    const translations = await loadGuardianEyeTranslations(language);
    if (language !== this._language) {
      return;
    }
    this._translations = translations;
    const metadata = window.customCards?.find(card => card.type === CARD_TAG);
    if (metadata) {
      metadata.name = translate(translations, "HANvrCardTitle", "Guardian Eye NVR");
      metadata.description = translate(translations, "HANvrCardDescription", "Recorder status and diagnostics.");
    }
    this._renderMetrics();
    await this._renderGauges();
    this._updateValues();
  }

  _renderMetrics() {
    const primary = [
      ["status", "HAEventPipeline", "Event Pipeline", this._entities.status],
      ["cameras", "HACamerasOnline", "Cameras Online", this._entities.cameras],
      ["recordings", "HAActiveRecordings", "Active Recordings", this._entities.recordings],
      ["pending", "HAPendingEvents", "Pending Deliveries", this._entities.pending],
    ];
    const secondary = [
      ["memory", "HADiagProcessMemory", "Guardian process memory", this._entities.memory],
      ["memoryLimit", "HADiagMainMemoryLimit", "Main process memory limit", this._entities.memoryLimit],
      ["inference", "HADiagMainInference", "AI inference (main process)", this._entities.inference],
      // Read from the status entity's attributes rather than from an entity of its own. Live streaming is
      // three numbers on a dashboard; giving each a sensor would add entities to every installation for
      // something a single line already says.
      ["live", "HALiveStreams", "Live Streams", this._entities.status],
      ["processes", "HADiagProcesses", "Guardian processes", this._entities.status],
    ];
    this._renderMetricGroup(".metrics.primary", primary);
    this._renderMetricGroup(".metrics.secondary", secondary);
  }

  /**
   * Live streaming in one line: how many cameras are publishing, how many people are watching.
   *
   * Three distinct absences, and they must not read alike. No attributes at all means this build has no
   * live streaming — an em dash. A router that is not running is said in words, because zero publications
   * with a stopped router is not the same news as zero publications with a healthy one. And a viewer count
   * the router did not answer is omitted rather than shown as zero.
   */
  _live() {
    const attributes = this._state(this._entities.status)?.attributes;
    if (!attributes || attributes.live_router_running === undefined || attributes.live_router_running === null) {
      return "—";
    }

    if (!attributes.live_router_running) {
      return this._t("HALiveRouterUnavailable", "Video router unavailable");
    }

    const publications = attributes.live_active_publications ?? 0;
    const stale = attributes.live_stale_publications ?? 0;
    const viewers = attributes.live_viewers;

    const parts = [`${publications}`];
    if (viewers !== undefined && viewers !== null) {
      parts.push(`${viewers} ${this._t("HALiveViewers", "watching")}`);
    }
    if (stale > 0) {
      parts.push(`${stale} ${this._t("HALiveStale", "silent")}`);
    }

    return parts.join(" · ");
  }

  _renderMetricGroup(selector, definitions) {
    const container = this.shadowRoot.querySelector(selector);
    container.replaceChildren(...definitions.map(([id, key, fallback, entity]) => {
      const card = document.createElement("ha-card");
      card.className = "metric action";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.innerHTML = `<div class="label"></div><div class="value" data-value="${id}">—</div>`;
      card.querySelector(".label").textContent = this._t(key, fallback);
      card.addEventListener("click", () => this._showMoreInfo(entity));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this._showMoreInfo(entity);
        }
      });
      return card;
    }));
  }

  async _renderGauges() {
    const renderVersion = (this._gaugeRenderVersion || 0) + 1;
    this._gaugeRenderVersion = renderVersion;
    const helpers = await window.loadCardHelpers();
    const definitions = [
      [this._entities.cpu, "CPU", 60, 85],
      [this._entities.gpu, "GPU", 70, 90],
      [this._entities.storage, this._t("HAStorageUsed", "Storage Used"), 75, 90],
    ];
    const gauges = await Promise.all(definitions.map(([entity, name, yellow, red]) =>
      helpers.createCardElement({
        type: "gauge", entity, name, min: 0, max: 100, needle: true,
        severity: { green: 0, yellow, red },
        tap_action: { action: "more-info" },
      })));
    if (renderVersion !== this._gaugeRenderVersion) {
      return;
    }
    this._gauges = gauges;
    if (this._hass) {
      gauges.forEach((gauge) => { gauge.hass = this._hass; });
    }
    this.shadowRoot.querySelector(".gauges").replaceChildren(...gauges);
  }

  _updateValues() {
    if (!this._hass) {
      return;
    }
    const status = this._state(this._entities.status)?.attributes?.status;
    const values = {
      status: this._status(status),
      cameras: this._stateValue(this._entities.cameras),
      recordings: this._stateValue(this._entities.recordings),
      pending: this._stateValue(this._entities.pending),
      memory: this._stateValue(this._entities.memory, " MB"),
      memoryLimit: this._stateValue(this._entities.memoryLimit, " MB"),
      inference: this._inference(),
      live: this._live(),
      processes: this._state(this._entities.status)?.attributes?.resource_process_count ?? "—",
    };
    for (const [id, value] of Object.entries(values)) {
      const element = this.shadowRoot.querySelector(`[data-value="${id}"]`);
      if (element) element.textContent = value;
    }
    this._updateHealth(status);
  }

  _inference() {
    const attributes = this._state(this._entities.status)?.attributes || {};
    // The main-process detector may be initialized without ever processing a camera frame.
    return attributes.ai_initialized === true && attributes.ai_total_frames > 0
      ? this._stateValue(this._entities.inference, " ms") : "—";
  }

  refreshDiagnostics(now = Date.now()) {
    this._updateHealth(undefined, now);
  }

  _updateHealth(_status, now = Date.now()) {
    const { status, fresh, pending, retries, storage } = nvrDiagnostics(
      this._entities, this._hass?.states, now, this._config.diagnostics_stale_seconds);
    const issues = [];
    if (!fresh || !status) issues.push(`🟠 ${this._t("HADiagNvrUnconfirmed", "NVR health is unconfirmed: telemetry is missing or out of date")}`);
    else if (status !== "ready") issues.push(`🔴 ${this._t("HAEventPipeline", "Event Pipeline")}: ${this._status(status)}`);
    if ([pending, retries, storage].some(value => value === null))
      issues.push(`🟠 ${this._t("HADiagNvrMissing", "Queue or storage measurements are missing")}`);
    if (pending > 0) issues.push(`🟠 ${this._t("HAPendingEvents", "Pending Deliveries")}: ${pending}`);
    if (retries > 0) issues.push(`🟠 ${this._t("HADeliveryRetries", "Delivery Retries")}: ${retries}`);
    if (storage >= 75) issues.push(`🟠 ${this._t("HAStorageUsed", "Storage Used")}: ${storage}%`);
    const target = this.shadowRoot.querySelector(".health-content");
    target.replaceChildren();
    if (!issues.length) {
      target.textContent = this._t("HADiagNvrClear", "No issues in the reported queue and storage measurements");
      return;
    }
    for (const issue of issues) {
      const row = document.createElement("div");
      row.className = "issue";
      row.textContent = issue;
      target.append(row);
    }
  }

  _status(status) {
    const definitions = {
      ready: ["HAStatusReady", "Ready"],
      degraded: ["HAStatusDegraded", "Degraded"],
      failed: ["HAStatusFailed", "Failed"],
    };
    const definition = definitions[status];
    return definition ? this._t(definition[0], definition[1]) : (status || "—");
  }

  _state(entity) { return this._hass?.states?.[entity]; }
  _showMoreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      detail: { entityId },
    }));
  }
  _stateValue(entity, suffix = "", fallback = "—") {
    const state = this._state(entity)?.state;
    return !state || state === "unknown" || state === "unavailable" ? fallback : `${state}${suffix}`;
  }
  _t(key, fallback) { return translate(this._translations, key, fallback); }
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, GuardianEyeNvrCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Guardian Eye NVR Card",
    description: "Localized Guardian Eye NVR telemetry.",
  });
}
