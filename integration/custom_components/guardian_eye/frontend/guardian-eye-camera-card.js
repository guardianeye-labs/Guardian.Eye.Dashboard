import {
  homeAssistantLanguage,
  loadGuardianEyeTranslations,
  localizeRecordingModeHass,
  localizeAiDetectionHass,
  localizeRecordingMode,
  translate,
} from "./guardian-eye-localization.js?v=1.0.23";
import { WhepSession } from "./guardian-eye-whep.js?v=1.0.23";
import { cameraDiagnostics, diagnosticsReport, DIAGNOSTIC_STATUS } from "./guardian-eye-diagnostics.js?v=1.0.23";

const CARD_TAG = "guardian-eye-camera-card";

/**
 * Reason codes the backend and the WHEP client emit, mapped to localisation keys. A code with no entry
 * falls back to the generic message rather than rendering the raw code — an English snake_case token in a
 * Japanese dashboard is worse than a vague sentence.
 */
const LIVE_REASON_LABELS = {
  camera_off: ["HALiveCameraOff", "Camera is off"],
  starting: ["HALiveStarting", "Starting live video"],
  limit_exceeded: ["HALiveLimitExceeded", "All live camera slots are in use"],
  guardian_auth_required: ["HALiveAuthRequired", "Renew the Guardian Eye token in integration settings"],
  tls_invalid: ["HALiveTlsInvalid", "Check the video TLS certificate and key"],
  disabled: ["HALiveDisabled", "Live video is off"],
  not_publishing: ["HALiveNotPublishing", "Not streaming"],
  router_unavailable: ["HALiveRouterUnavailable", "Video router unavailable"],
  encoder_unavailable: ["HALiveEncoderUnavailable", "No compatible encoder"],
  rate_limited: ["HALiveRateLimited", "Too many requests, try again shortly"],
  unauthorized: ["HALiveUnauthorized", "Access was refused"],
  not_found: ["HALiveNotFound", "Stream not found"],
  unreachable: ["HALiveUnreachable", "Cannot reach the video router"],
  mixed_content: ["HALiveMixedContent", "The dashboard is HTTPS and the video router is not"],
  unsupported: ["HALiveUnsupported", "This browser cannot play WebRTC"],
  connection_failed: ["HALiveConnectionFailed", "Could not reach the video stream"],
};

const LIVE_GENERIC_FAILURE = ["HALiveUnavailable", "Live video unavailable"];

/** Bound the whole broker request, including retries while a publication starts. */
const ACCESS_TIMEOUT_MS = 22000;
const ENTITY_LABELS = [
  ["_stream", "HACameraConnection", "Camera connection"],
  ["_motion", "TimelineMotion", "Motion"],
  ["_ai_detection", "TimelineAI", "AI Detection"],
  ["_person", "HAObjectPerson", "Person"],
  ["_vehicle", "HAObjectVehicle", "Vehicle"],
  ["_animal", "HAObjectAnimal", "Animal"],
  ["_recording", "Recording", "Recording"],
  ["_power", "HADiagCapture", "Capture"],
];

class GuardianEyeCameraCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    if (!config?.title || !Array.isArray(config.entities)) {
      throw new Error("Guardian Eye camera card requires title and entities");
    }

    // Reconfiguration replaces the whole shell, <video> included. A session still attached to the element
    // about to be thrown away would keep negotiating against a node nobody can see, holding a viewer slot on
    // the router until it times out. Home Assistant calls setConfig repeatedly on one instance while the
    // dashboard editor is open, so this is an ordinary path, not an edge case.
    void this._stopLive();
    clearInterval(this._diagnosticsTimer);

    this._config = config;
    this._diagnosticsInputs = null;
    this._renderedHass = null;
    this._entitiesCard = null;
    this._entitiesLabelsSignature = null;
    this._renderVersion = (this._renderVersion || 0) + 1;
    this._entitiesRenderPending = false;
    const rowEntities = (rows) => rows.flatMap((row) => typeof row === "string" ? [row]
      : [row?.entity, ...rowEntities(row?.entities || [])]);
    this._watchedEntities = [...new Set([
      ...rowEntities(config.entities), config.image_entity, config.recording_mode_entity,
      config.live_entity, config.live_camera_entity,
      ...Object.values(config.diagnostics || {}),
    ].filter(Boolean))];
    this._renderShell();
  }

  set hass(value) {
    this._hass = value;
    const previous = this._renderedHass;
    // HA supplies a new hass object for every entity update. Localizing an entities card copies the
    // state map, so doing it for every camera on every unrelated update is quadratic in fleet size.
    if (previous && value && ["language", "locale", "themes", "selectedTheme", "config", "user", "connection"]
      .every((key) => previous[key] === value[key])
      && this._watchedEntities.every((id) => previous.states?.[id] === value.states?.[id])) return;
    this._renderedHass = value;
    const language = homeAssistantLanguage(value);
    if (language !== this._language) {
      this._language = language;
      this._translations = {};
      this._entitiesLabelsSignature = null;
      void this._loadTranslations(language);
    }
    this._renderEntitiesIfNeeded();
    this._setEntitiesHass();
    this._updateSnapshot();
    this._updateLive();
    this.refreshDiagnostics();
  }

  /**
   * The card was removed from the DOM — a dashboard tab switch, a view rebuild, a browser navigation.
   *
   * Tearing the session down here rather than leaving it to garbage collection is the difference between
   * a viewer that hangs up and one that keeps the publication busy until the router times it out.
   */
  disconnectedCallback() {
    void this._stopLive();
    clearInterval(this._diagnosticsTimer);
    this._diagnosticsTimer = null;
  }

  connectedCallback() {
    this._syncDiagnosticsClock();
  }

  getCardSize() {
    return Math.max(6, this._config?.entities?.length ?? 0);
  }

  getGridOptions() {
    return {
      columns: 12,
      min_columns: 9,
      max_columns: 12,
      rows: "auto",
    };
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { min-inline-size: 260px; }
        ha-card {
          border: 1px solid var(--guardian-eye-accent, #00d4ff);
          border-radius: 12px;
          box-sizing: border-box;
          overflow: hidden;
        }
        h1 {
          box-sizing: border-box;
          font-size: var(--ha-font-size-xl);
          font-weight: var(--ha-font-weight-normal);
          line-height: 1.25;
          margin: 0;
          overflow: hidden;
          padding: 13px 12px 9px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .snapshot {
          align-items: center;
          aspect-ratio: 16 / 9;
          background: var(--secondary-background-color);
          display: flex;
          justify-content: center;
          overflow: hidden;
          width: 100%;
        }
        .snapshot img {
          height: 100%;
          object-fit: cover;
          width: 100%;
        }
        .placeholder {
          color: var(--disabled-text-color);
          --mdc-icon-size: 42px;
        }
        .snapshot.has-image .placeholder { display: none; }
        .snapshot:has(.live-button:not([hidden])) .placeholder { display: none; }
        .snapshot:not(.has-image) img { display: none; }
        .snapshot { position: relative; }
        .snapshot video {
          height: 100%;
          object-fit: cover;
          width: 100%;
        }
        .snapshot:not(.live-playing) video { display: none; }
        .snapshot.live-playing img,
        .snapshot.live-playing .placeholder,
        .snapshot.live-playing .live-button { display: none; }
        .live-button {
          align-items: center;
          appearance: none;
          background: rgba(10, 18, 30, 0.8);
          border: 2px solid var(--guardian-eye-accent, #00d4ff);
          border-radius: 50%;
          box-sizing: border-box;
          color: var(--guardian-eye-accent, #00d4ff);
          cursor: pointer;
          display: flex;
          block-size: 48px;
          inline-size: 48px;
          justify-content: center;
          inset-block-start: calc(50% - 24px);
          inset-inline-start: calc(50% - 24px);
          padding: 0;
          position: absolute;
        }
        .live-button svg { display: block; width: 24px; height: 24px; fill: currentColor; }
        .live-button:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
        .live-button[hidden] { display: none; }
        .live-stop {
          align-items: center;
          background: rgba(10, 18, 30, 0.9);
          border: 1px solid var(--guardian-eye-accent, #00d4ff);
          border-radius: 50%;
          box-sizing: border-box;
          color: var(--guardian-eye-accent, #00d4ff);
          cursor: pointer;
          display: flex;
          justify-content: center;
          width: 40px;
          height: 40px;
          padding: 0;
          position: absolute;
          inset-block-start: 8px;
          inset-inline-end: 8px;
        }
        .live-stop svg { width: 20px; height: 20px; fill: currentColor; }
        .live-stop span { display: none; }
        .live-stop[hidden] { display: none; }
        .live-stop:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        .live-message {
          background: rgba(0, 0, 0, 0.55);
          box-sizing: border-box;
          color: var(--primary-text-color, #e8eef6);
          font-size: var(--ha-font-size-s, 12px);
          inset-block-end: 0;
          inset-inline: 0;
          padding: 4px 8px;
          position: absolute;
          text-align: center;
        }
        .live-message[hidden] { display: none; }
        .diagnostics { border-top: 1px solid var(--divider-color); padding: 10px 12px; }
        .diagnostics summary { cursor: pointer; font-size: 0.85rem; line-height: 1.5; }
        .diagnostics[data-category="problem"] summary { color: var(--error-color, #ff8b83); }
        .diagnostics[data-category="unknown"] summary { color: var(--warning-color, #f0c674); }
        .diagnostics dl { font-size: 0.82rem; margin: 10px 0; }
        .diagnostics-body { max-height: 32rem; overflow-y: auto; padding-inline-end: 4px; }
        .diagnostics dt { color: var(--secondary-text-color); margin-top: 10px; }
        .diagnostics dd { margin: 2px 0 0; overflow-wrap: anywhere; }
        .diagnostics p { color: var(--secondary-text-color); font-size: 0.78rem; line-height: 1.5; }
        .diagnostics button { background: transparent; border: 1px solid var(--divider-color);
          border-radius: 6px; color: inherit; cursor: pointer; padding: 8px; font: inherit; }
        .diagnostics :focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
      </style>
      <ha-card>
        <h1></h1>
        <div class="snapshot">
          <img alt="" />
          <video playsinline muted autoplay></video>
          <ha-icon class="placeholder" icon="mdi:image-off-outline"></ha-icon>
          <button class="live-button" type="button" hidden>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" /></svg>
          </button>
          <button class="live-stop" type="button" hidden>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6h12v12H6z" /></svg>
            <span></span>
          </button>
          <div class="live-message" hidden></div>
        </div>
        <div class="entities"></div>
        <details class="diagnostics">
          <summary></summary>
          <div class="diagnostics-body">
          <p class="diagnostics-note"></p>
          <dl>${["report", "source", "decode", "preview", "restarts", "mode", "analysis", "motion", "event", "recording"]
            .map(key => `<dt data-diag-label="${key}"></dt><dd data-diag-value="${key}"></dd>`).join("")}</dl>
          <p class="diagnostics-limitations"></p>
          <button class="diagnostics-download" type="button"></button>
          </div>
        </details>
      </ha-card>`;

    const heading = this.shadowRoot.querySelector("h1");
    heading.textContent = this._config.title;
    heading.title = this._config.full_title || this._config.title;
    this._image = this.shadowRoot.querySelector("img");
    this._snapshot = this.shadowRoot.querySelector(".snapshot");
    this._image.addEventListener("load", () => {
      this._snapshot.classList.add("has-image");
    });
    this._image.addEventListener("error", () => {
      this._snapshot.classList.remove("has-image");
    });

    this._video = this.shadowRoot.querySelector("video");
    this._liveButton = this.shadowRoot.querySelector(".live-button");
    this._liveStop = this.shadowRoot.querySelector(".live-stop");
    this._liveMessage = this.shadowRoot.querySelector(".live-message");
    // Explicit play, never autoplay. Starting a WebRTC session for every camera tile the moment a
    // dashboard opens would hold a publisher and a viewer slot per tile, on a machine that may be
    // recording all of them.
    this._liveButton.addEventListener("click", () => void this._startLive());
    this._liveStop.addEventListener("click", () => {
      this._liveFailure = null;
      void this._stopLive();
    });
    this._diagnostics = this.shadowRoot.querySelector(".diagnostics");
    this._diagnostics.addEventListener("toggle", () => {
      this.refreshDiagnostics();
      this._syncDiagnosticsClock();
    });
    this.shadowRoot.querySelector(".diagnostics-download")
      .addEventListener("click", () => this._downloadDiagnostics());
    this.refreshDiagnostics();
  }

  _syncDiagnosticsClock() {
    clearInterval(this._diagnosticsTimer);
    this._diagnosticsTimer = this.isConnected && this._diagnostics?.open
      ? setInterval(() => this.refreshDiagnostics(), 10_000) : null;
  }

  openDiagnostics() {
    this._diagnostics.open = true;
    this.refreshDiagnostics();
    this.scrollIntoView({ block: "center", behavior: "smooth" });
    this._diagnostics.querySelector("summary").focus({ preventScroll: true });
  }

  refreshDiagnostics(now = Date.now()) {
    const inputs = [this._config, this._translations, this._language, this._diagnostics?.open,
      Math.floor(now / 10_000), ...Object.values(this._config?.diagnostics || {}).map(id => this._hass?.states?.[id]),
      ...Object.values(this._config?.object_entities || {}).map(id => this._hass?.states?.[id])];
    if (this._diagnosticsInputs?.length === inputs.length
      && inputs.every((value, index) => value === this._diagnosticsInputs[index])) return this.diagnosticModel;
    this._diagnosticsInputs = inputs;
    const model = cameraDiagnostics(this._config, this._hass?.states, now);
    this.diagnosticModel = model;
    if (!this._diagnostics) return model;
    const t = (key, fallback) => translate(this._translations, key, fallback);
    this._diagnostics.dataset.category = model.category;
    this._diagnostics.querySelector("summary").textContent =
      `${t("HADiagnostics", "Diagnostics")} · ${t(...DIAGNOSTIC_STATUS[model.status])}`;
    if (!this._diagnostics.open) return model;
    const m = model.measurements;
    const unknown = t("HADiagNoData", "No data");
    const formatDate = value => value ? new Date(value).toLocaleString(this._language || "en") : unknown;
    const seconds = value => value === null ? unknown : `${value.toFixed(1)} ${t("HADiagSeconds", "s")}`;
    const eventType = model.lastEvent?.event_type || "";
    const eventLabel = eventType === "ai_detected" ? t("TimelineAI", "AI Detection")
      : eventType.includes("motion") ? t("TimelineMotion", "Motion") : t("HADiagCameraEvent", "Camera event");
    const rows = [
      ["report", "HADiagReportTime", "Report time", formatDate(m.captured_at)],
      ["source", "HADiagVideoAge", "Video data age at report", seconds(m.video_data_age_seconds)],
      ["decode", "HADiagDecode", "Decoded frames at report", `${m.frames_per_second === null ? unknown : m.frames_per_second.toFixed(2) + " FPS"} · ${seconds(m.decoded_frame_age_seconds)}`],
      ["preview", "HADiagPreviewAge", "Preview age at report", seconds(m.preview_frame_age_seconds)],
      ["restarts", "HADiagRestarts", "Capture restarts", m.capture_restarts === null ? unknown : String(m.capture_restarts)],
      ["mode", "HADiagMode", "Recording mode", model.mode ? localizeRecordingMode(this._translations, model.mode) : unknown],
      ["analysis", "HADiagAnalysis", "Frame analysis", model.analysis.fresh
        ? `${t("HADiagAiAnalyzed", "AI analyzed a frame")} · ${formatDate(model.analysis.analyzed_at)}`
        : model.mode === "AI" && model.analysis.reported
          ? t("HADiagAiUnavailable", "No fresh successful AI analysis")
          : t("HADiagAnalysisUnknown", "Processing freshness is not reported; no detections does not mean a failure")],
      ["motion", "TimelineMotion", "Motion", model.motion === "on" ? t("HADiagMotionDetected", "Motion reported")
        : model.motion === "off" ? t("HADiagMotionClear", "No active motion reported") : unknown],
      ["event", "HADiagHaEvent", "Last event observed in HA", model.lastEvent
        ? `${eventLabel} · ${formatDate(model.lastEvent.observed_in_ha_at)}` : t("HADiagNoEvent", "No event available in HA")],
      ["recording", "Recording", "Recording", model.recording === "on" ? t("HADiagRecordingActive", "Recording reported active")
        : model.recording === "off" ? t("HADiagRecordingIdle", "No active recording reported") : unknown],
    ];
    for (const [key, label, fallback, value] of rows) {
      this.shadowRoot.querySelector(`[data-diag-label="${key}"]`).textContent = t(label, fallback);
      this.shadowRoot.querySelector(`[data-diag-value="${key}"]`).textContent = value;
    }
    this.shadowRoot.querySelector(".diagnostics-note").textContent = t("HADiagReportNote",
      "Measurements describe the report time, not this instant. Old or unavailable data cannot confirm camera health.");
    this.shadowRoot.querySelector(".diagnostics-limitations").textContent = t("HADiagLimitations",
      "An event in HA does not confirm a saved file or a completed automation. Capture restarts do not count every network retry. Capture power is not physical camera power.");
    this.shadowRoot.querySelector(".diagnostics-download").textContent = t("HADiagDownload", "Download diagnostic report");
    return model;
  }

  _downloadDiagnostics() {
    const report = diagnosticsReport(this._config, this._hass?.states);
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `guardian-eye-diagnostics-${report.camera_id || "camera"}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async _renderEntities() {
    const renderVersion = (this._renderVersion ?? 0) + 1;
    this._renderVersion = renderVersion;
    this._entitiesRenderPending = true;
    try {
      const helpers = await window.loadCardHelpers();
      const card = await helpers.createCardElement({
        type: "entities",
        show_header_toggle: false,
        entities: this._localizedEntities(),
      });

      if (renderVersion !== this._renderVersion) {
        return;
      }

      this._entitiesCard = card;
      this._setEntitiesHass();
      this.shadowRoot.querySelector(".entities").replaceChildren(card);
      requestAnimationFrame(() => void this._compactNestedCard(card));
    } finally {
      if (renderVersion === this._renderVersion) this._entitiesRenderPending = false;
    }
  }

  async _loadTranslations(language) {
    const translations = await loadGuardianEyeTranslations(language);
    if (language !== this._language) {
      return;
    }
    this._translations = translations;
    const metadata = window.customCards?.find(card => card.type === CARD_TAG);
    if (metadata) {
      metadata.name = translate(translations, "HACameraCardTitle", "Guardian Eye camera");
      metadata.description = translate(translations, "HACameraCardDescription", "Camera video, snapshots and controls.");
    }
    this._renderEntitiesIfNeeded();
    this._setEntitiesHass();
    this._updateLive();
    this.refreshDiagnostics();
  }

  _setEntitiesHass() {
    if (!this._entitiesCard || !this._hass) {
      return;
    }
    this._entitiesCard.hass = localizeRecordingModeHass(
      localizeAiDetectionHass(this._hass, this._config.ai_entity, this._translations),
      this._config.recording_mode_entity,
      this._translations,
    );
  }

  _renderEntitiesIfNeeded() {
    const labelsSignature = this._labelsSignature();
    if ((!this._entitiesCard && !this._entitiesRenderPending)
      || labelsSignature !== this._entitiesLabelsSignature) {
      this._entitiesLabelsSignature = labelsSignature;
      void this._renderEntities();
    }
  }

  _localizedEntities() {
    return this._config.entities.map((row) => {
      if (row?.type === "buttons" && Array.isArray(row.entities)) {
        // Button rows are built from the HA entity registry. Do not drop them when the
        // state machine is still catching up with newly discovered retained entities.
        return row.entities.length ? row : null;
      }

      if (!row || typeof row !== "object" || typeof row.entity !== "string") {
        return row;
      }
      if (row.name === "") {
        return row;
      }

      const objectRole = Object.entries(this._config.object_entities || {})
        .find(([, entity]) => entity === row.entity)?.[0];
      const roleSuffix = objectRole ? `_${objectRole}` : Object.entries({ stream: "_stream", motion: "_motion", recording: "_recording", power: "_power" })
        .find(([role]) => this._config.diagnostics?.[role] === row.entity)?.[1];
      const definition = ENTITY_LABELS.find(([suffix]) => roleSuffix ? suffix === roleSuffix : row.entity.endsWith(suffix));
      if (!definition) {
        return row;
      }
      return {
        ...row,
        name: translate(this._translations, definition[1], definition[2]),
      };
    }).filter(Boolean);
  }

  _labelsSignature() {
    return JSON.stringify(this._localizedEntities().map((row) => ({
      entity: row?.entity ?? null,
      entities: row?.entities?.map((button) => button.entity) ?? null,
      name: row?.name ?? null,
    })));
  }

  async _whenRendered(element) {
    if (!element) return;
    // HA loads its row elements lazily. updateComplete is absent until their class is registered.
    if (!customElements.get(element.localName)) await customElements.whenDefined(element.localName);
    await element.updateComplete;
  }

  async _compactNestedCard(card = this._entitiesCard) {
    if (!card) return;
    await this._whenRendered(card);
    if (card !== this._entitiesCard) return;
    const root = card.shadowRoot;
    const nested = root?.querySelector("ha-card");
    if (!nested) {
      return;
    }
    nested.style.background = "transparent";
    nested.style.border = "0";
    nested.style.borderRadius = "0";
    nested.style.boxShadow = "none";
    nested.style.setProperty("--entities-card-row-gap", "0px");
    nested.style.setProperty("--paper-item-min-height", "32px");
    nested.style.setProperty("--md-list-item-one-line-container-height", "32px");

    if (!root.querySelector("style[data-guardian-eye-compact]")) {
      const style = document.createElement("style");
      style.dataset.guardianEyeCompact = "";
      style.textContent = `
        .card-content { padding: 6px 9px 10px !important; }
        #states > div { margin-block: -4px; }
        #states > div:has(> hui-buttons-row) { margin-block: 3px 7px; }
        #states > div:has(> hui-select-entity-row) {
          margin-block: 0;
          max-width: 160px;
        }
      `;
      root.append(style);
    }

    await Promise.all([
      this._compactButtonRows(root), this._compactSelectRows(root), this._compactEntityRows(root),
    ]);
  }

  async _compactButtonRows(root) {
    for (const row of root.querySelectorAll("hui-buttons-row")) {
      await this._whenRendered(row);
      const buttons = row.shadowRoot?.querySelector("hui-buttons-base");
      await this._whenRendered(buttons);
      const buttonsRoot = buttons?.shadowRoot;
      if (!buttonsRoot || buttonsRoot.querySelector("style[data-guardian-eye-buttons]")) {
        continue;
      }

      const style = document.createElement("style");
      style.dataset.guardianEyeButtons = "";
      style.textContent = `
        .ha-scrollbar {
          box-sizing: border-box !important;
          height: 38px !important;
          flex-wrap: nowrap !important;
          gap: 4px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          scrollbar-width: none !important;
          padding: 3px 0 !important;
        }
        .ha-scrollbar::-webkit-scrollbar { display: none !important; }
        ha-assist-chip {
          box-sizing: border-box !important;
          flex: 0 0 36px !important;
          min-width: 0 !important;
          max-width: 36px !important;
          width: 36px !important;
        }
      `;
      buttonsRoot.append(style);
    }
  }

  async _compactEntityRows(root) {
    await Promise.all([...root.querySelectorAll("#states > div > :not(hui-buttons-row)")].map(async row => {
      await this._whenRendered(row);
      const generic = row.shadowRoot?.querySelector("hui-generic-entity-row");
      await this._whenRendered(generic);
      const rowRoot = generic?.shadowRoot;
      if (!rowRoot || rowRoot.querySelector("style[data-guardian-eye-labels]")) return;
      const style = document.createElement("style");
      style.dataset.guardianEyeLabels = "";
      style.textContent = `
        state-badge { flex: 0 0 28px; width: 28px; }
        .info { min-width: 0; margin-inline: 8px; white-space: normal !important;
          overflow: visible !important; text-overflow: clip; line-height: 1.35; padding-block: 4px; }
        .value { max-width: 50%; text-align: end; overflow-wrap: anywhere; }
      `;
      rowRoot.append(style);
    }));
  }

  async _compactSelectRows(root) {
    for (const row of root.querySelectorAll("hui-select-entity-row")) {
      await this._whenRendered(row);
      const rowRoot = row.shadowRoot;
      const select = rowRoot?.querySelector("ha-select");
      await this._whenRendered(select);
      select?.style.setProperty("--ha-color-form-background", "#101a2e");
      select?.style.setProperty("--ha-color-form-background-disabled", "#111827");
      select?.style.setProperty(
        "--ha-color-fill-primary-quiet-resting",
        "rgba(0, 212, 255, 0.16)",
      );
      select?.style.setProperty(
        "--ha-color-fill-primary-quiet-hover",
        "rgba(0, 212, 255, 0.24)",
      );
      select?.style.setProperty("--primary-text-color", "#e8eef6");
      select?.style.setProperty("--secondary-text-color", "#9ca3af");
      select?.style.setProperty("--wa-color-surface-raised", "#101a2e");
      select?.style.setProperty("--wa-color-text-normal", "#e8eef6");
      select?.style.setProperty(
        "--wa-color-neutral-fill-normal",
        "rgba(0, 212, 255, 0.24)",
      );

      const selectRoot = select?.shadowRoot;
      if (selectRoot && !selectRoot.querySelector("style[data-guardian-eye-select-menu]")) {
        const menuStyle = document.createElement("style");
        menuStyle.dataset.guardianEyeSelectMenu = "";
        menuStyle.textContent = `
          ha-dropdown-item {
            color: #e8eef6 !important;
          }
          ha-dropdown-item[selected] {
            background-color: rgba(0, 212, 255, 0.16) !important;
            color: #67e8f9 !important;
          }
          ha-dropdown-item:hover,
          ha-dropdown-item:focus,
          ha-dropdown-item:focus-visible,
          ha-dropdown-item[selected]:hover {
            background-color: rgba(0, 212, 255, 0.24) !important;
            color: #67e8f9 !important;
          }
        `;
        selectRoot.append(menuStyle);
      }

      const picker = select?.shadowRoot?.querySelector("ha-picker-field");
      await this._whenRendered(picker);
      const pickerRoot = picker?.shadowRoot;
      if (!pickerRoot || pickerRoot.querySelector("style[data-guardian-eye-select]")) {
        continue;
      }

      const style = document.createElement("style");
      style.dataset.guardianEyeSelect = "";
      style.textContent = `
        ha-combo-box-item {
          background-color: #101a2e !important;
          color: var(--primary-text-color, #e8eef6) !important;
          --md-list-item-label-text-color: var(--primary-text-color, #e8eef6);
          --md-list-item-supporting-text-color: var(--secondary-text-color, #9ca3af);
          --mdc-select-label-ink-color: var(--secondary-text-color, #9ca3af);
          --md-list-item-one-line-container-height: 36px !important;
          --md-list-item-two-line-container-height: 36px !important;
          --md-list-item-leading-space: 10px !important;
          --md-list-item-trailing-space: 4px !important;
        }
        ha-combo-box-item[disabled] {
          background-color: #111827 !important;
        }
      `;
      pickerRoot.append(style);
    }
  }

  // ── Live video ────────────────────────────────────────────────────────────

  /**
   * The retained description of this camera's stream, or null when the entity is absent.
   *
   * `unavailable` and `unknown` are Home Assistant sentinels rather than values we publish — they mean
   * Guardian Eye is not connected to the broker at all, which is a different thing from a camera that is
   * simply not streaming. The backend says the latter with the state value `offline` and a reason.
   */
  _liveState() {
    const entity = this._config?.live_entity;
    const state = entity ? this._hass?.states?.[entity] : null;
    return state && state.state !== "unavailable" && state.state !== "unknown" ? state : null;
  }

  /**
   * Reflects the current live state onto the shell.
   *
   * Split from starting playback on purpose: this runs on every hass update, several times a second on a
   * busy installation, and must stay cheap and idempotent.
   */
  _updateLive() {
    if (!this._liveButton || !this._liveMessage) {
      return;
    }
    this._liveButton.setAttribute("aria-label", translate(this._translations, "HALivePlay", "Play live video"));
    if (this._liveStop) {
      const label = this._starting
        ? translate(this._translations, "Cancel", "Cancel")
        : translate(this._translations, "HALiveStop", "Stop viewing");
      this._liveStop.setAttribute("aria-label", label);
      this._liveStop.title = label;
      this._liveStop.querySelector("span").textContent = label;
      this._liveStop.hidden = !this._config?.live || !(this._starting || this._session);
    }

    // Opt-in. The card is already installed in people's dashboards showing a snapshot; turning that into
    // a live player without being asked changes what their cameras do.
    if (!this._config?.live) {
      this._liveButton.hidden = true;
      this._liveMessage.hidden = true;
      return;
    }

    const state = this._liveState();
    const camera = this._hass?.states?.[this._config?.live_camera_entity];
    const poweredOff = camera?.state === "off";
    const unavailable = !camera || ["unavailable", "unknown"].includes(camera.state);
    if ((poweredOff || unavailable) && (this._starting || this._session || this._negotiatingSession)) {
      void this._stopLive();
    }
    this._liveButton.hidden = Boolean(this._starting || this._session || poweredOff || unavailable);
    if (this._liveFailure) {
      this._showLiveMessage(this._liveFailure);
    } else if (poweredOff || unavailable) {
      this._showLiveMessage(poweredOff ? "camera_off" : "unavailable");
    } else if (this._starting) {
      this._showLiveMessage("starting");
    } else if (!this._session && state?.attributes?.reason && state.attributes.reason !== "not_publishing") {
      this._showLiveMessage(state.attributes.reason);
    } else {
      this._showLiveMessage(null);
    }
  }

  _showLiveMessage(reason) {
    if (!this._liveMessage) {
      return;
    }
    if (!reason) {
      this._liveMessage.hidden = true;
      this._liveMessage.textContent = "";
      return;
    }

    const [key, fallback] = LIVE_REASON_LABELS[reason] ?? LIVE_GENERIC_FAILURE;
    this._liveMessage.textContent = translate(this._translations, key, fallback);
    this._liveMessage.hidden = false;
  }

  /**
   * Asks for access and negotiates playback.
   *
   * Every failure ends with a message on the tile. A player that simply stays black is the single most
   * common complaint about camera dashboards, and every reason we could have shown was known here.
   */
  async _startLive() {
    if (this._session || this._starting) {
      return;
    }
    this._starting = true;
    this._updateLive();

    // Which attempt this is. Negotiation takes a WHEP round trip plus up to two seconds of ICE gathering,
    // and this._session is only set once all of that has succeeded — so a card removed from the DOM in the
    // meantime finds nothing to stop, and the session that lands afterwards is attached to a detached
    // element and never hung up. Anything that cancels playback bumps the epoch; a start that comes back to
    // find it changed hangs up its own session instead of publishing it.
    const epoch = (this._liveEpoch = (this._liveEpoch ?? 0) + 1);

    // Asking again clears the last answer. Leaving it up would make a successful retry look like it had
    // failed too.
    //
    // Every failure below records itself here rather than painting the tile directly. The `finally` runs
    // _updateLive, and a camera that is still publishing makes that pass wipe any message written straight
    // to the element — so "no endpoint", "access refused" and "rate limited" were each shown for a frame and
    // then replaced by a bare play button. That is the exact blank tile this code says it exists to prevent,
    // and it is the common case: the camera publishes fine, it is OUR attempt that failed.
    this._liveFailure = null;

    try {
      const access = await this._requestAccess();
      if (epoch !== this._liveEpoch) return;
      if (!access?.authorization || !access?.whepUrl) {
        this._liveFailure = access?.reason ?? "unauthorized";
        return;
      }
      const url = access.viaHomeAssistant ? new URL(access.whepUrl, globalThis.location.origin).href : access.whepUrl;
      const session = this._createSession(access);
      this._negotiatingSession = session;
      let result;
      try {
        result = await session.start({
          url,
          authorization: access.authorization,
          mediaElement: this._video,
          // Negotiation succeeding is not the stream working. ICE and DTLS come after, and when they fail
          // the tile would otherwise sit black and silent — so the failure is turned back into the play
          // button and a sentence.
          onFailed: (reason) => {
            if (epoch !== this._liveEpoch) return;
            this._liveFailure = reason;
            void this._stopLive();
            this._updateLive();
          },
        });
      } catch (error) {
        // A throw out of negotiation leaves a session nobody holds: this is the only reference to it, and
        // the caller is a click handler, so letting it escape loses both the connection and the message.
        await session.stop();
        if (epoch !== this._liveEpoch) return;
        this._liveFailure = "connection_failed";
        return;
      }

      if (!result.ok) {
        await session.stop();
        if (epoch !== this._liveEpoch) return;
        this._liveFailure = result.reason;
        return;
      }

      if (epoch !== this._liveEpoch) {
        // The card was unmounted, reconfigured or stopped while this was negotiating. Publishing the
        // session now would hand it to nobody: hang it up here, which is the only place still holding it.
        await session.stop();
        return;
      }

      this._session = session;
      this._snapshot.classList.add("live-playing");
      this._showLiveMessage(null);
    } finally {
      if (epoch === this._liveEpoch) {
        this._negotiatingSession = undefined;
        this._starting = false;
        this._updateLive();
      }
    }
  }

  /**
   * The one seam in the playback path. `WhepSession` is imported statically and drives a real WebRTC stack,
   * so without this hook nothing about _startLive could be exercised in a test — which is how the two
   * lifecycle leaks fixed above (unmount and reconfigure while negotiating) reached the branch unnoticed.
   */
  _createSession(access) {
    if (access?.viaHomeAssistant) {
      const origin = globalThis.location.origin;
      const endpoint = new URL(access.whepUrl, origin);
      if (endpoint.origin !== origin || !/^\/api\/guardian_eye\/whep\/[0-9a-f]{32}$/.test(endpoint.pathname)
          || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error("Invalid HA video endpoint");
      return new WhepSession({ fetchImpl: (url, options) => {
        const target = new URL(url, origin);
        if (target.href !== endpoint.href) throw new Error("Invalid HA session endpoint");
        const headers = { ...options.headers };
        delete headers.Authorization;
        return this._hass.fetchWithAuth(target.pathname, { ...options, headers });
      } });
    }
    return new WhepSession();
  }

  async _stopLive() {
    // Bumped even when there is no session to stop: that is precisely the case where a start is still
    // negotiating, and this is what tells it not to publish what it is about to get.
    this._liveEpoch = (this._liveEpoch ?? 0) + 1;

    this._accessAbort?.abort();
    const session = this._session ?? this._negotiatingSession;
    this._negotiatingSession = undefined;
    this._session = undefined;
    this._starting = false;
    this._snapshot?.classList.remove("live-playing");
    if (this._video) {
      this._video.srcObject = null;
    }
    this._updateLive();
    await session?.stop();
  }

  /** The HA backend checks entity permissions and keeps the permanent Guardian token server-side. */
  async _requestAccess() {
    const entityId = this._config?.live_camera_entity;
    if (!entityId || !this._hass?.fetchWithAuth) return { reason: "unavailable" };
    const controller = new AbortController();
    this._accessAbort = controller;
    const timeout = setTimeout(() => controller.abort(), ACCESS_TIMEOUT_MS);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await this._hass.fetchWithAuth("/api/guardian_eye/live/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity_id: entityId }),
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
        const result = await response.json();
        if (response.ok) return result;
        if (result?.reason !== "starting" || attempt === 2) {
          return { reason: result?.reason ?? "unauthorized" };
        }
        // Match Guardian's retry interval and allow its five-second reconciliation pass to finish.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (controller.signal.aborted) return { reason: "unreachable" };
      }
    } catch {
      return { reason: "unreachable" };
    } finally {
      clearTimeout(timeout);
      if (this._accessAbort === controller) this._accessAbort = undefined;
    }
  }

  _updateSnapshot() {
    if (!this._image || !this._snapshot) {
      return;
    }

    const state = this._hass?.states?.[this._config.image_entity];
    const source = state?.attributes?.entity_picture;
    if (!source || state.state === "unknown" || state.state === "unavailable") {
      this._image.removeAttribute("src");
      this._snapshot.classList.remove("has-image");
      return;
    }

    const separator = source.includes("?") ? "&" : "?";
    const versionedSource = `${source}${separator}v=${encodeURIComponent(state.state)}`;
    if (this._image.getAttribute("src") !== versionedSource) {
      this._snapshot.classList.remove("has-image");
      this._image.src = versionedSource;
    }
  }
}

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, GuardianEyeCameraCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Guardian Eye Camera Card",
    description: "A fixed Guardian Eye snapshot and controls card.",
  });
}
