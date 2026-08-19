import "./guardian-eye-icons.js?v=1.0.0";
import "./guardian-eye-camera-card.js?v=1.0.0";
import "./guardian-eye-nvr-card.js?v=1.0.0";
import {
  homeAssistantLanguage,
  loadGuardianEyeTranslations,
  translate,
} from "./guardian-eye-localization.js?v=1.0.0";
import {
  cameraConfig,
  guardianCameraDevices,
  nvrConfig,
} from "./guardian-eye-dashboard-config.js?v=1.0.0";

const DASHBOARD_CARD_TAG = "guardian-eye-dashboard-card";
const DASHBOARD_STRATEGY_TAG = "ll-strategy-dashboard-guardian-eye";

class GuardianEyeDashboardCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._renderShell();
  }

  setConfig(config) {
    this._config = config || {};
  }

  set hass(value) {
    this._hass = value;
    this._updateChildren();
    this._ensureRegistryLoaded();
    this._ensureRegistrySubscriptions();

    const language = homeAssistantLanguage(value);
    if (language !== this._language) {
      this._language = language;
      void this._loadTranslations(language);
    }
  }

  connectedCallback() {
    this._ensureRegistryLoaded();
    this._ensureRegistrySubscriptions();
  }

  disconnectedCallback() {
    clearTimeout(this._registryReloadTimer);
    for (const unsubscribe of this._unsubscribers || []) unsubscribe();
    this._unsubscribers = null;
  }

  getCardSize() {
    return 12;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --primary-color: #00d4ff;
          --accent-color: #06b6d4;
          --primary-background-color: #0a0f1c;
          --secondary-background-color: #0f1629;
          --card-background-color: #182132;
          --ha-card-background: #182132;
          --primary-text-color: #e8eef6;
          --secondary-text-color: #9ca3af;
          --disabled-text-color: #5b6472;
          --divider-color: rgba(255, 255, 255, 0.1);
          --state-icon-color: #67d9e8;
          --state-icon-active-color: #00d4ff;
          --switch-checked-color: #00d4ff;
          --switch-checked-button-color: #00232e;
          --switch-checked-track-color: #06b6d4;
          --ha-card-border-color: #00d4ff;
          --ha-card-border-radius: 12px;
          --ha-card-box-shadow: none;
          color: var(--primary-text-color);
          display: block;
        }
        ha-card.dashboard {
          background: var(--primary-background-color);
          border: 0;
          border-radius: 0;
          box-shadow: none;
          box-sizing: border-box;
          min-height: calc(100vh - var(--header-height, 56px));
          padding: 20px;
        }
        .content { margin: 0 auto; max-width: 1440px; }
        h1, h2 { font-weight: 400; margin: 0; }
        h1 { font-size: 1.35rem; margin-bottom: 10px; }
        h2 { font-size: 1.05rem; margin: 24px 2px 10px; }
        guardian-eye-nvr-card { display: block; }
        .camera-grid {
          display: grid;
          gap: 8px;
          grid-template-columns: repeat(4, minmax(260px, 1fr));
        }
        guardian-eye-camera-card { display: block; min-width: 0; }
        .message {
          background: var(--card-background-color);
          border: 1px solid var(--ha-card-border-color);
          border-radius: var(--ha-card-border-radius);
          color: var(--secondary-text-color);
          padding: 18px;
        }
        @media (max-width: 1180px) {
          .camera-grid { grid-template-columns: repeat(3, minmax(260px, 1fr)); }
        }
        @media (max-width: 880px) {
          .camera-grid { grid-template-columns: repeat(2, minmax(260px, 1fr)); }
        }
        @media (max-width: 600px) {
          ha-card.dashboard { padding: 10px; }
          .camera-grid { grid-template-columns: minmax(260px, 1fr); }
        }
      </style>
      <ha-card class="dashboard">
        <div class="content">
          <h1>Guardian Eye NVR</h1>
          <guardian-eye-nvr-card></guardian-eye-nvr-card>
          <h2 class="cameras-title">Cameras</h2>
          <div class="camera-grid"><div class="message">Loading cameras…</div></div>
        </div>
      </ha-card>`;
    this._nvrCard = this.shadowRoot.querySelector("guardian-eye-nvr-card");
    this._nvrCard.setConfig({});
  }

  _ensureRegistryLoaded() {
    if (
      !this.isConnected
      || !this._hass
      || this._registryLoaded
      || this._registryLoad
      || Date.now() < (this._registryRetryAt || 0)
    ) return;
    this._registryLoad = this._loadRegistry().finally(() => {
      this._registryLoad = null;
    });
  }

  async _loadRegistry() {
    try {
      const [entities, devices] = await Promise.all([
        this._hass.callWS({ type: "config/entity_registry/list" }),
        this._hass.callWS({ type: "config/device_registry/list" }),
      ]);
      this._entities = entities;
      this._devices = devices;
      this._registryLoaded = true;
      this._registryRetryAt = 0;
      this._nvrCard.setConfig(nvrConfig(devices, entities));
      this._nvrCard.hass = this._hass;
      this._renderCameras();
    } catch (error) {
      this._registryRetryAt = Date.now() + 10_000;
      this._showError(error);
    }
  }

  _ensureRegistrySubscriptions() {
    if (!this._hass || this._unsubscribers || this._subscriptionsPromise) return;
    this._subscriptionsPromise = this._subscribeToRegistry().finally(() => {
      this._subscriptionsPromise = null;
    });
  }

  async _subscribeToRegistry() {
    try {
      const unsubscribers = await Promise.all([
        this._hass.connection.subscribeEvents(
          () => this._scheduleRegistryReload(),
          "entity_registry_updated",
        ),
        this._hass.connection.subscribeEvents(
          () => this._scheduleRegistryReload(),
          "device_registry_updated",
        ),
      ]);
      if (!this.isConnected) {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
        return;
      }
      this._unsubscribers = unsubscribers;
    } catch {
      this._unsubscribers = [];
    }
  }

  _scheduleRegistryReload() {
    clearTimeout(this._registryReloadTimer);
    this._registryLoaded = false;
    this._registryRetryAt = 0;
    this._registryReloadTimer = setTimeout(() => this._ensureRegistryLoaded(), 250);
  }

  _renderCameras() {
    const cameras = guardianCameraDevices(this._devices);
    const grid = this.shadowRoot.querySelector(".camera-grid");
    if (!cameras.length) {
      const message = document.createElement("div");
      message.className = "message";
      message.textContent = this._t("NoCameras", "No Guardian Eye cameras found");
      grid.replaceChildren(message);
      this._cameraCards = [];
      return;
    }

    this._cameraCards = cameras.map((device) => {
      const card = document.createElement("guardian-eye-camera-card");
      card.setConfig(cameraConfig(device, this._entities));
      if (this._hass) card.hass = this._hass;
      return card;
    });
    grid.replaceChildren(...this._cameraCards);
  }

  _showError(error) {
    const message = this.shadowRoot.querySelector(".message")
      || document.createElement("div");
    message.className = "message";
    message.textContent = `Guardian Eye: ${error?.message || "Failed to load devices"}`;
    this.shadowRoot.querySelector(".camera-grid").replaceChildren(message);
  }

  async _loadTranslations(language) {
    const translations = await loadGuardianEyeTranslations(language);
    if (language !== this._language) return;
    this._translations = translations;
    this.shadowRoot.querySelector(".cameras-title").textContent =
      this._t("Cameras", "Cameras");
    if (this._devices) this._renderCameras();
  }

  _updateChildren() {
    if (!this._hass) return;
    if (this._nvrCard) this._nvrCard.hass = this._hass;
    for (const card of this._cameraCards || []) card.hass = this._hass;
  }

  _t(key, fallback) {
    return translate(this._translations, key, fallback);
  }
}

export class GuardianEyeDashboardStrategy extends HTMLElement {
  static async generate(config) {
    const title = config?.title || "Guardian Eye";
    return {
      title,
      views: [{
        title,
        path: "overview",
        type: "panel",
        cards: [{ type: `custom:${DASHBOARD_CARD_TAG}` }],
      }],
    };
  }

  static getCreateSuggestions() {
    return { title: "Guardian Eye", icon: "guardian-eye:logo" };
  }
}

GuardianEyeDashboardStrategy.noEditor = true;

if (!customElements.get(DASHBOARD_CARD_TAG)) {
  customElements.define(DASHBOARD_CARD_TAG, GuardianEyeDashboardCard);
}
if (!customElements.get(DASHBOARD_STRATEGY_TAG)) {
  customElements.define(DASHBOARD_STRATEGY_TAG, GuardianEyeDashboardStrategy);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === DASHBOARD_CARD_TAG)) {
  window.customCards.push({
    type: DASHBOARD_CARD_TAG,
    name: "Guardian Eye Dashboard",
    description: "A dynamic Guardian Eye NVR and camera dashboard.",
  });
}

window.customStrategies = window.customStrategies || [];
if (!window.customStrategies.some((strategy) =>
  strategy.type === "guardian-eye" && strategy.strategyType === "dashboard")) {
  window.customStrategies.push({
    type: "guardian-eye",
    strategyType: "dashboard",
    name: "Guardian Eye",
    description: "NVR telemetry, camera status and controls.",
    documentationURL: "https://github.com/guardianeye-labs/Guardian.Eye.Dashboard",
  });
}
