import assert from "node:assert/strict";
import test from "node:test";
import { cameraDiagnostics } from "../dist/guardian-eye-diagnostics.js";

// DOM lifecycle shim: any removal (including replaceChildren) disconnects a card, just as a browser does.
class Element {
  children = [];
  style = {};
  dataset = {};
  nodes = new Map();
  isConnected = true;
  setConfig(config) { this.config = this._config = config; this.configurations = (this.configurations || 0) + 1; }
  refreshDiagnostics(now) { return cameraDiagnostics(this.config, this.hass?.states, now); }
  addEventListener() {}
  append(child) { if (child.parent) child.remove(); this.children.push(child); child.parent = this; }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
    this.disconnections = (this.disconnections || 0) + 1;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); children.forEach(c => this.append(c)); }
  querySelector(selector) {
    if (selector === ".message") return this.children.find(c => c.className === "message");
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  attachShadow() {
    const nodes = new Map([".camera-grid", ".cameras-title", "guardian-eye-nvr-card", ".fleet-health"].map(s => [s, new Element()]));
    this.shadowRoot = { querySelector: selector => nodes.get(selector) || null };
  }
}
globalThis.HTMLElement = Element;
globalThis.window = globalThis;
globalThis.document = { createElement: () => new Element() };
const definitions = new Map();
globalThis.customElements = { get: name => definitions.get(name), define: (name, value) => definitions.set(name, value) };
await import("../dist/guardian-eye-dashboard.js");
const Dashboard = definitions.get("guardian-eye-dashboard-card");

function fleet(count) {
  const devices = Array.from({ length: count }, (_, i) => ({
    id: `device-${i}`, name: `Camera ${String(i).padStart(3, "0")}`,
    manufacturer: "Guardian Eye", model: "Video Surveillance Camera",
  }));
  const entities = devices.map(device => ({
    device_id: device.id, entity_id: `switch.${device.id}_power`, platform: "mqtt",
    unique_id: `guardian_eye_${device.id}_power`,
  }));
  return { devices, entities };
}
function dashboard(count = 200) {
  const card = new Dashboard();
  const registry = fleet(count);
  card._devices = registry.devices;
  card._entities = registry.entities;
  card._registryLoaded = true;
  card._language = "en";
  card._unsubscribers = [];
  card._hass = { language: "en", states: {} };
  card._renderCameras();
  return { card, registry };
}

test("200 camera cards survive repeated registry and translation renders", () => {
  const { card } = dashboard();
  const original = [...card._cameraCards];
  for (let i = 0; i < 10; i++) card._renderCameras();
  assert.deepEqual(card._cameraCards, original);
  for (const camera of original) {
    assert.equal(camera.configurations, 1);
    assert.equal(camera.disconnections || 0, 0);
  }
  card._showError(new Error("temporary registry failure"));
  assert.equal(card.shadowRoot.querySelector(".camera-grid").children.length, 200);
});

test("adding/removing/reordering cameras leaves other connected cards intact", () => {
  const { card } = dashboard(200);
  const original = [...card._cameraCards];
  const updated = fleet(201);
  card._devices = updated.devices.slice(1).reverse();
  card._entities = updated.entities;
  card._renderCameras();
  assert.equal(card._cameraCards.length, 200);
  assert.equal(original[0].disconnections, 1);
  for (const camera of original.slice(1)) {
    assert.ok(card._cameraCards.includes(camera));
    assert.equal(camera.configurations, 1);
    assert.equal(camera.disconnections || 0, 0);
  }
});

test("HA state updates cannot bypass the registry debounce", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { card, registry } = dashboard();
  let requests = 0;
  card._hass.callWS = async ({ type }) => {
    requests++;
    return type.includes("entity_registry") ? registry.entities : registry.devices;
  };
  for (let i = 0; i < 100; i++) {
    card._scheduleRegistryReload();
    card.hass = { ...card._hass, states: {} };
  }
  assert.equal(requests, 0);
  t.mock.timers.tick(250);
  await card._registryLoad;
  assert.equal(requests, 2);
  card.disconnectedCallback();
});

test("registry events during a pending request cause one follow-up without dropping cameras", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { card, registry } = dashboard(1);
  let release;
  let requests = 0;
  const pending = new Promise(resolve => { release = resolve; });
  card._hass.callWS = async ({ type }) => {
    requests++;
    await pending;
    return type.includes("entity_registry") ? registry.entities : registry.devices;
  };
  card._scheduleRegistryReload();
  t.mock.timers.tick(250);
  const first = card._registryLoad;
  card._scheduleRegistryReload();
  t.mock.timers.tick(250); // Debounce expires while the first request is still in flight.
  release();
  await first;
  assert.equal(requests, 2);
  assert.equal(card._registryLoaded, false);
  t.mock.timers.tick(250);
  await card._registryLoad;
  assert.equal(requests, 4);
  assert.equal(card._registryLoaded, true);
  assert.equal(card._cameraCards[0].disconnections || 0, 0);
  card.disconnectedCallback();
});
