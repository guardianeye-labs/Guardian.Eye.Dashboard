import {
  homeAssistantLanguage,
  loadGuardianEyeTranslations,
  translate,
} from "./guardian-eye-localization.js?v=1.0.2-rc4";

const CARD_TAG = "guardian-eye-camera-card";
const ENTITY_LABELS = [
  ["_stream", "ScannerTabHlsStream", "Stream"],
  ["_motion", "TimelineMotion", "Motion"],
  ["_ai_detection", "TimelineAI", "AI Detection"],
  ["_recording", "Recording", "Recording"],
  ["_power", "HAPower", "Power"],
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

    this._config = config;
    this._renderShell();
  }

  set hass(value) {
    this._hass = value;
    if (this._entitiesCard) {
      this._entitiesCard.hass = value;
    }
    const language = homeAssistantLanguage(value);
    if (language !== this._language) {
      this._language = language;
      this._translations = {};
      this._entitiesLabelsSignature = null;
      void this._loadTranslations(language);
    }
    this._renderEntitiesIfNeeded();
    this._updateSnapshot();
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
        ha-card { overflow: hidden; }
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
        .snapshot:not(.has-image) img { display: none; }
      </style>
      <ha-card>
        <h1></h1>
        <div class="snapshot">
          <img alt="" />
          <ha-icon class="placeholder" icon="mdi:image-off-outline"></ha-icon>
        </div>
        <div class="entities"></div>
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
  }

  async _renderEntities() {
    const renderVersion = (this._renderVersion ?? 0) + 1;
    this._renderVersion = renderVersion;
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
    if (this._hass) {
      card.hass = this._hass;
    }
    this.shadowRoot.querySelector(".entities").replaceChildren(card);
    requestAnimationFrame(() => void this._compactNestedCard());
  }

  async _loadTranslations(language) {
    const translations = await loadGuardianEyeTranslations(language);
    if (language !== this._language) {
      return;
    }
    this._translations = translations;
    this._entitiesLabelsSignature = null;
    this._renderEntitiesIfNeeded();
  }

  _renderEntitiesIfNeeded() {
    const labelsSignature = this._labelsSignature();
    if (!this._entitiesCard || labelsSignature !== this._entitiesLabelsSignature) {
      this._entitiesLabelsSignature = labelsSignature;
      void this._renderEntities();
    }
  }

  _localizedEntities() {
    return this._config.entities.map((row) => {
      if (row?.type === "buttons" && Array.isArray(row.entities)) {
        const entities = row.entities.filter((button) =>
          typeof button?.entity !== "string" || this._hass?.states?.[button.entity]);
        return entities.length ? { ...row, entities } : null;
      }

      if (!row || typeof row !== "object" || typeof row.entity !== "string") {
        return row;
      }
      if (row.name === "") {
        return row;
      }

      const definition = ENTITY_LABELS.find(([suffix]) => row.entity.endsWith(suffix));
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

  async _compactNestedCard() {
    await this._entitiesCard?.updateComplete;
    const root = this._entitiesCard?.shadowRoot;
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
        .card-content { padding: 4px 9px 7px !important; }
        #states > div { margin-block: -4px; }
        #states > div:has(> hui-buttons-row) { margin-block: 2px 4px; }
        #states > div:has(> hui-select-entity-row) {
          margin-block: 0;
          max-width: 160px;
        }
      `;
      root.append(style);
    }

    await this._compactButtonRows(root);
    await this._compactSelectRows(root);
  }

  async _compactButtonRows(root) {
    for (const row of root.querySelectorAll("hui-buttons-row")) {
      await row.updateComplete;
      const buttons = row.shadowRoot?.querySelector("hui-buttons-base");
      await buttons?.updateComplete;
      const buttonsRoot = buttons?.shadowRoot;
      if (!buttonsRoot || buttonsRoot.querySelector("style[data-guardian-eye-buttons]")) {
        continue;
      }

      const style = document.createElement("style");
      style.dataset.guardianEyeButtons = "";
      style.textContent = `
        .ha-scrollbar {
          flex-wrap: nowrap !important;
          gap: 4px !important;
          overflow: hidden !important;
          padding: 3px 0 !important;
        }
        ha-assist-chip {
          flex: 0 0 34px !important;
          max-width: 34px !important;
          width: 34px !important;
        }
      `;
      buttonsRoot.append(style);
    }
  }

  async _compactSelectRows(root) {
    for (const row of root.querySelectorAll("hui-select-entity-row")) {
      await row.updateComplete;
      const rowRoot = row.shadowRoot;
      const select = rowRoot?.querySelector("ha-select");
      await select?.updateComplete;
      const picker = select?.shadowRoot?.querySelector("ha-picker-field");
      await picker?.updateComplete;
      const pickerRoot = picker?.shadowRoot;
      if (!pickerRoot || pickerRoot.querySelector("style[data-guardian-eye-select]")) {
        continue;
      }

      const style = document.createElement("style");
      style.dataset.guardianEyeSelect = "";
      style.textContent = `
        ha-combo-box-item {
          background-color: var(--ha-color-form-background, #101a2e) !important;
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
          background-color: var(--ha-color-form-background-disabled, #111827) !important;
        }
      `;
      pickerRoot.append(style);
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
