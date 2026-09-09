import assert from "node:assert/strict";
import test from "node:test";

/**
 * The card is a custom element, so exercising it needs just enough DOM to let `_renderShell` run. The shim
 * below is deliberately dumb: it records nothing about markup and answers `querySelector` from a fixed
 * table, because what is under test is the live-session lifecycle, not HTML.
 */
function stubElement() {
  return {
    hidden: false,
    textContent: "",
    srcObject: null,
    dataset: {},
    style: { setProperty() {} },
    classList: {
      _set: new Set(),
      add(name) {
        this._set.add(name);
      },
      remove(name) {
        this._set.delete(name);
      },
      contains(name) {
        return this._set.has(name);
      },
    },
    listeners: {},
    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
    replaceChildren() {},
    removeAttribute() {},
    getAttribute() {
      return null;
    },
    setAttribute() {},
    querySelector() { return this.summary ||= stubElement(); },
  };
}

const SELECTORS = ["h1", "img", "video", ".snapshot", ".live-button", ".live-stop", ".live-message", ".entities", ".diagnostics", ".diagnostics-download"];
SELECTORS.push(".diagnostics-note", ".diagnostics-limitations");
for (const key of ["report", "source", "decode", "preview", "restarts", "mode", "analysis", "motion", "event", "recording"])
  SELECTORS.push(`[data-diag-label="${key}"]`, `[data-diag-value="${key}"]`);

globalThis.HTMLElement = class {
  attachShadow() {
    const elements = new Map(SELECTORS.map((selector) => [selector, stubElement()]));
    this.shadowRoot = {
      elements,
      set innerHTML(_value) {},
      querySelector(selector) {
        return elements.get(selector) ?? null;
      },
      querySelectorAll() {
        return [];
      },
    };
    return this.shadowRoot;
  }
};
globalThis.window = globalThis;
globalThis.window.customCards = [];
globalThis.requestAnimationFrame = () => {};
globalThis.loadCardHelpers = async () => ({
  createCardElement: async () => ({ updateComplete: Promise.resolve(), shadowRoot: null }),
});

const defined = new Map();
globalThis.customElements = {
  define(name, definition) {
    defined.set(name, definition);
  },
  get(name) {
    return defined.get(name);
  },
};

await import("../dist/guardian-eye-camera-card.js");
const CameraCard = defined.get("guardian-eye-camera-card");

const LIVE_ENTITY = "sensor.front_live";
const CAMERA_ENTITY = "camera.front_live";
const ACCESS = { authorization: "Bearer viewer:temporary", whepUrl: "http://guardian.local:8889/live/11111111222233334444555555555555/whep" };
function hass({ live = "offline", power = "idle", reason = "not_publishing", calls = [], result = ACCESS, status = 200 } = {}) {
  return {
    language: "en",
    states: {
      [CAMERA_ENTITY]: { state: power, attributes: {} },
      [LIVE_ENTITY]: { state: live, attributes: { reason } },
    },
    async fetchWithAuth(url, options) {
      calls.push({ url, options });
      return { ok: status === 200, json: async () => result };
    },
    callService() { throw new Error("No MQTT access requests may be sent"); },
  };
}
function card({ live = true } = {}) {
  const element = new CameraCard();
  element.setConfig({ title: "Front Door", entities: [], image_entity: "image.front_snapshot", live, live_entity: LIVE_ENTITY, live_camera_entity: CAMERA_ENTITY });
  element.hass = hass();
  return element;
}
function pendingSession() {
  let release;
  const session = { stopped: false, async start() { await session.pending; return { ok: true }; }, async stop() { session.stopped = true; } };
  session.pending = new Promise(resolve => { release = resolve; });
  session.release = release;
  return session;
}

test("diagnostics can open and expire while preserving the current viewer and video element", () => {
  const element = card();
  const session = pendingSession();
  const video = element._video;
  element._session = session;
  element._diagnostics.open = true;
  element.refreshDiagnostics(Date.now() + 180_000);
  assert.equal(element._session, session);
  assert.equal(element._video, video);
  assert.equal(session.stopped, false);
  assert.match(element.shadowRoot.querySelector('[data-diag-value="analysis"]').textContent, /not reported/);
});

test("200 cards update only for their own entities and still use the latest HA connection", async () => {
  let updates = 0;
  const elements = Array.from({ length: 200 }, (_, i) => {
    const element = new CameraCard();
    element.setConfig({ title: `Camera ${i}`, entities: [{ entity: `switch.camera_${i}` }],
      live_camera_entity: CAMERA_ENTITY, live: false });
    element._language = "en";
    // Count assignments to the native HA entities card, where state-map localization and rendering happen.
    element._entitiesCard = { set hass(value) { updates++; this.latest = value; } };
    element._entitiesLabelsSignature = element._labelsSignature();
    return element;
  });
  const initial = hass();
  for (let i = 0; i < 200; i++) initial.states[`switch.camera_${i}`] = { state: "off" };
  for (const element of elements) element.hass = initial;
  assert.equal(updates, 200);
  const calls = [];
  const unrelated = { ...initial, states: { ...initial.states, "sensor.weather": { state: "sunny" } },
    fetchWithAuth: hass({ calls }).fetchWithAuth };
  for (const element of elements) element.hass = unrelated;
  assert.equal(updates, 200, "an unrelated update must not rebuild 200 localized HA state maps");
  await elements[0]._requestAccess();
  assert.equal(calls.length, 1, "auth must use the latest hass object even when rendering is skipped");
  const changed = { ...unrelated, states: { ...unrelated.states, "switch.camera_123": { state: "on" } } };
  for (const element of elements) element.hass = changed;
  assert.equal(updates, 201);
  assert.equal(elements[123]._entitiesCard.latest.states["switch.camera_123"].state, "on");
});

test("state updates during async helper loading create only one native entities card", async () => {
  const original = globalThis.loadCardHelpers;
  let release;
  let loads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  globalThis.loadCardHelpers = async () => { loads++; await pending; return original(); };
  try {
    const element = new CameraCard();
    element.setConfig({ title: "Camera", entities: [CAMERA_ENTITY], live: false });
    element._language = "en";
    for (let i = 0; i < 100; i++) element.hass = hass();
    assert.equal(loads, 1);
    release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.ok(element._entitiesCard);
  } finally {
    release();
    globalThis.loadCardHelpers = original;
  }
});

test("an idle camera offers play before its publication exists", () => {
  const element = card();
  assert.equal(element._liveButton.hidden, false);
  assert.equal(element._liveMessage.hidden, true);
});
test("live disabled in the card hides play", () => {
  assert.equal(card({ live: false })._liveButton.hidden, true);
});
test("a powered-off camera explains why play is unavailable", () => {
  const element = card(); element.hass = hass({ power: "off" });
  assert.equal(element._liveButton.hidden, true);
  assert.equal(element._liveMessage.textContent, "Camera is off");
});
test("access sends only the HA entity identity to the authenticated HA backend", async () => {
  const calls = []; const element = card(); element.hass = hass({ calls });
  assert.deepEqual(await element._requestAccess(), ACCESS);
  assert.equal(calls[0].url, "/api/guardian_eye/live/open");
  assert.deepEqual(JSON.parse(calls[0].options.body), { entity_id: CAMERA_ENTITY });
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.headers.Authorization, undefined);
});
test("a typed refusal is retained on the card and allows retry", async () => {
  const element = card(); element.hass = hass({ status: 429, result: { reason: "rate_limited" } });
  await element._startLive();
  assert.equal(element._liveMessage.textContent, "Too many requests, try again shortly");
  assert.equal(element._liveButton.hidden, false);
});
test("cold-start retries allow reconciliation to finish within the access timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const element = card();
  let requests = 0;
  element._hass.fetchWithAuth = async () => {
    requests++;
    return { ok: requests === 3, json: async () => requests === 3 ? ACCESS : { reason: "starting" } };
  };
  const result = element._requestAccess();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(2999);
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(requests, 2);
  t.mock.timers.tick(3000);
  assert.deepEqual(await result, ACCESS);
  assert.equal(requests, 3);
});
test("removing the card cancels an in-flight HA request", async () => {
  const element = card(); let signal;
  element._hass.fetchWithAuth = async (_, options) => {
    signal = options.signal;
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const playing = element._startLive(); element.disconnectedCallback(); await playing;
  assert.equal(signal.aborted, true); assert.equal(element._session, undefined);
});
test("a late HA response after unmount cannot create a peer", async () => {
  const element = card(); let release;
  element._requestAccess = () => new Promise(resolve => { release = resolve; });
  element._createSession = () => { throw new Error("must not create a peer"); };
  const playing = element._startLive(); element.disconnectedCallback(); release(ACCESS); await playing;
  assert.equal(element._session, undefined);
});
test("unmount during SDP negotiation immediately stops the peer", async () => {
  const element = card(); const session = pendingSession(); element._createSession = () => session;
  const playing = element._startLive();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(element._negotiatingSession, session);
  element.disconnectedCallback(); assert.equal(session.stopped, true);
  session.release(); await playing; assert.equal(element._session, undefined);
});
test("reconfiguration stops a playing session", async () => {
  const element = card(); const session = pendingSession(); element._createSession = () => session;
  session.release(); await element._startLive(); assert.equal(element._session, session);
  element.setConfig({ ...element._config });
  assert.equal(session.stopped, true); assert.equal(element._session, undefined);
});
test("a failed negotiation releases the peer and restores play", async () => {
  const element = card(); const session = { stopped: false, async start() { throw new Error("failed"); }, async stop() { this.stopped = true; } };
  element._createSession = () => session; await element._startLive();
  assert.equal(session.stopped, true); assert.equal(element._liveButton.hidden, false);
  assert.equal(element._liveMessage.textContent, "Could not reach the video stream");
});
test("power-off tears down an active session", async () => {
  const element = card(); const session = pendingSession(); element._createSession = () => session;
  session.release(); await element._startLive(); element.hass = hass({ power: "off" });
  assert.equal(session.stopped, true); assert.equal(element._video.srcObject, null);
});

test("visible Stop viewing closes only this viewer and restores Play", async () => {
  const element = card(); const session = pendingSession(); element._createSession = () => session;
  const states = element._hass.states;
  assert.equal(element._liveStop.hidden, true);
  session.release(); await element._startLive();
  assert.equal(element._liveStop.hidden, false);
  assert.equal(element._liveStop.querySelector("span").textContent, "Stop viewing");
  element._liveStop.listeners.click();
  assert.equal(session.stopped, true);
  assert.equal(element._video.srcObject, null);
  assert.equal(element._session, undefined);
  assert.equal(element._liveStop.hidden, true);
  assert.equal(element._liveButton.hidden, false);
  assert.equal(element._hass.states, states, "capture/recording state is untouched");
});

test("Cancel permits immediate retry and a late response cannot clear the new session", async () => {
  const element = card(); let release;
  element._requestAccess = () => new Promise(resolve => { release = resolve; });
  const oldAttempt = element._startLive();
  assert.equal(element._liveStop.hidden, false);
  assert.equal(element._liveStop.querySelector("span").textContent, "Cancel");
  element._liveStop.listeners.click();
  assert.equal(element._starting, false);
  assert.equal(element._liveButton.hidden, false);
  const session = pendingSession(); element._createSession = () => session;
  element._requestAccess = async () => ACCESS;
  const retry = element._startLive();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  release(ACCESS); await oldAttempt;
  assert.equal(element._starting, true);
  assert.equal(element._negotiatingSession, session);
  session.release(); await retry;
  assert.equal(element._session, session);
  element._liveStop.listeners.click();
});

test("Cancel during negotiation closes the pending peer and prevents late playback", async () => {
  const element = card(); const session = pendingSession(); element._createSession = () => session;
  const pending = element._startLive();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  element._liveStop.listeners.click();
  assert.equal(session.stopped, true);
  session.release(); await pending;
  assert.equal(element._session, undefined);
  assert.equal(element._liveButton.hidden, false);
  assert.equal(element._liveStop.hidden, true);
});

test("HA signalling sends HA auth only to its fixed local endpoint and preserves SDP headers", async () => {
  const previous = globalThis.location;
  globalThis.location = { origin: "https://ha.example", protocol: "https:" };
  try {
    const element = card();
    const calls = [];
    element.hass = hass({ calls });
    const path = "/api/guardian_eye/whep/" + "a".repeat(32);
    const session = element._createSession({ viaHomeAssistant: true, whepUrl: path });
    await session._fetch("https://ha.example" + path, { method: "POST", headers: {
      Authorization: "HomeAssistant", "Content-Type": "application/sdp"
    }, body: "v=0" });
    assert.equal(calls[0].url, path);
    assert.equal(calls[0].options.headers["Content-Type"], "application/sdp");
    assert.equal(calls[0].options.headers.Authorization, undefined);
    assert.throws(() => session._fetch("https://other.example" + path, {}));
    assert.throws(() => element._createSession({ viaHomeAssistant: true, whepUrl: "https://other.example" + path }));
    assert.throws(() => element._createSession({ viaHomeAssistant: true, whepUrl: path + "?token=x" }));
  } finally { globalThis.location = previous; }
});
