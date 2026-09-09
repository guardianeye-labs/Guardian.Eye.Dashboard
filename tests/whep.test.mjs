import assert from "node:assert/strict";
import test from "node:test";

const {
  WhepSession,
  WhepFailure,
  isMixedContent,
} = await import("../dist/guardian-eye-whep.js");

/**
 * A peer connection that behaves like the browser's for the parts this client touches, and records what
 * was done to it. ICE gathering is already complete: the real wait is covered separately.
 */
class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.transceivers = [];
    this.iceGatheringState = "complete";
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this.ontrack = null;
  }

  addTransceiver(kind, options) {
    this.transceivers.push({ kind, ...options });
  }

  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "v=0\r\no=- offer\r\n" });
  }

  setLocalDescription(description) {
    this.localDescription = description;
    return Promise.resolve();
  }

  setRemoteDescription(description) {
    this.remoteDescription = description;
    return Promise.resolve();
  }

  close() {
    this.closed = true;
  }

  addEventListener() {}

  removeEventListener() {}
}

function answer({ status = 201, location = "/live/cam/whep/session-1", sdp = "v=0\r\no=- answer\r\n" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === "Location" ? location : null) },
    text: () => Promise.resolve(sdp),
  };
}

function recordingFetch(response = answer()) {
  const calls = [];
  const impl = (url, options) => {
    calls.push({ url, ...options });
    return Promise.resolve(typeof response === "function" ? response(url, options) : response);
  };
  return { impl, calls };
}

const ACCESS = {
  url: "http://router.local:8889/live/cam/whep",
  authorization: "Bearer ge-view-x:s3cret",
};

test("a Location pointing off-origin does not receive the credential", async () => {
  const { impl, calls } = recordingFetch(answer({ location: "https://evil.example/session-1" }));
  const session = new WhepSession({ fetchImpl: impl, peerConnectionImpl: FakePeerConnection });

  assert.deepEqual(await session.start(ACCESS), { ok: true });
  await session.stop();

  // The DELETE carries the Authorization header. A Location off our origin is the same theft the endpoint
  // check prevents, one step later and from a server that has already answered once.
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
});

test("a relative Location is still honoured", async () => {
  const { impl, calls } = recordingFetch(answer({ location: "/live/cam/whep/session-9" }));
  const session = new WhepSession({ fetchImpl: impl, peerConnectionImpl: FakePeerConnection });

  await session.start(ACCESS);
  await session.stop();

  assert.equal(calls.at(-1).url, "http://router.local:8889/live/cam/whep/session-9");
});

test("an https page talking to an http router is detected before any request is made", () => {
  // The browser blocks this before the request leaves, so the failure would otherwise surface as a bare
  // network error — and nobody guesses "your dashboard is HTTPS and the router is not" from that.
  assert.equal(isMixedContent("https:", "http://router.local:8889/live/cam/whep"), true);
  assert.equal(isMixedContent("https:", "https://router.local:8889/live/cam/whep"), false);
  assert.equal(isMixedContent("http:", "http://router.local:8889/live/cam/whep"), false);
});

test("the offer is posted as SDP with the credential in a header", async () => {
  const { impl, calls } = recordingFetch();
  const session = new WhepSession({ fetchImpl: impl, peerConnectionImpl: FakePeerConnection });

  const result = await session.start(ACCESS);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["Content-Type"], "application/sdp");
  // Measured: the router rejects ?user=&pass= outright, so a header is the only way in.
  assert.equal(calls[0].headers.Authorization, "Bearer ge-view-x:s3cret");
  assert.ok(!calls[0].url.includes("pass="));
  assert.ok(calls[0].body.startsWith("v=0"));
});

test("playback is receive-only for both media kinds", async () => {
  const { impl } = recordingFetch();
  let created;
  const session = new WhepSession({
    fetchImpl: impl,
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }
    },
  });

  await session.start(ACCESS);

  // A sendrecv transceiver would offer to publish from the browser — the opposite of what a viewer is.
  assert.deepEqual(
    created.transceivers,
    [
      { kind: "video", direction: "recvonly" },
      { kind: "audio", direction: "recvonly" },
    ],
  );
});

test("the answer is applied and the incoming stream is attached to the element", async () => {
  const { impl } = recordingFetch();
  let created;
  const session = new WhepSession({
    fetchImpl: impl,
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }
    },
  });
  const mediaElement = {};

  await session.start({ ...ACCESS, mediaElement });
  const stream = { id: "stream-1" };
  created.ontrack({ streams: [stream] });

  assert.equal(created.remoteDescription.type, "answer");
  assert.ok(created.remoteDescription.sdp.includes("answer"));
  assert.equal(mediaElement.srcObject, stream);
});

test("a connection that fails after negotiation is reported, not swallowed", async () => {
  // Returning ok means the offer was answered, not that media flows. ICE and DTLS come after, and they do
  // fail in practice: Firefox declines loopback candidates outright, so a viewer on the same machine as
  // Guardian Eye configured with 127.0.0.1 negotiates perfectly and then connects to nothing. Measured,
  // not supposed -- Firefox 154 against the pinned router.
  const { impl } = recordingFetch();
  let created;
  const session = new WhepSession({
    fetchImpl: impl,
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }

      addEventListener(name, handler) {
        (this.handlers ??= {})[name] = handler;
      }
    },
  });

  const failures = [];
  assert.deepEqual(
    await session.start({ ...ACCESS, onFailed: (reason) => failures.push(reason) }),
    { ok: true });

  created.connectionState = "failed";
  created.handlers.connectionstatechange();

  assert.deepEqual(failures, [WhepFailure.ConnectionFailed]);
});

test("a momentary disconnect is not treated as a failure", async () => {
  // ICE says `disconnected` is transient by definition. Tearing a stream down on a blip would be worse
  // than the blip.
  const { impl } = recordingFetch();
  let created;
  const session = new WhepSession({
    fetchImpl: impl,
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }

      addEventListener(name, handler) {
        (this.handlers ??= {})[name] = handler;
      }
    },
  });

  const failures = [];
  await session.start({ ...ACCESS, onFailed: (reason) => failures.push(reason) });

  for (const state of ["connecting", "connected", "disconnected"]) {
    created.connectionState = state;
    created.handlers.connectionstatechange();
  }

  assert.deepEqual(failures, []);
});

test("a connection failing after we hung up is not reported", async () => {
  // Stopping closes the peer connection, which raises this event. Reporting it would show the viewer an
  // error for something they asked for.
  const { impl } = recordingFetch();
  let created;
  const session = new WhepSession({
    fetchImpl: impl,
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }

      addEventListener(name, handler) {
        (this.handlers ??= {})[name] = handler;
      }
    },
  });

  const failures = [];
  await session.start({ ...ACCESS, onFailed: (reason) => failures.push(reason) });
  await session.stop();

  created.connectionState = "failed";
  created.handlers.connectionstatechange();

  assert.deepEqual(failures, []);
});

test("hanging up deletes the session the router named and closes the connection", async () => {
  const { impl, calls } = recordingFetch();
  let created;
  const session = new WhepSession({
    fetchImpl: impl,
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }
    },
  });

  await session.start(ACCESS);
  await session.stop();

  const remove = calls.at(-1);
  assert.equal(remove.method, "DELETE");
  assert.equal(remove.url, "http://router.local:8889/live/cam/whep/session-1");
  assert.equal(remove.headers.Authorization, ACCESS.authorization);
  assert.equal(created.closed, true);
  assert.equal(session.isActive, false);
});

test("a router that will not answer the DELETE still leaves nothing running locally", async () => {
  let created;
  const session = new WhepSession({
    fetchImpl: (url, options) =>
      options.method === "DELETE"
        ? Promise.reject(new Error("router is gone"))
        : Promise.resolve(answer()),
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }
    },
  });

  await session.start(ACCESS);
  await session.stop();

  // A card being removed from the DOM must not keep a live peer connection because the router did not
  // answer its goodbye.
  assert.equal(created.closed, true);
});

test("stopping twice is harmless", async () => {
  const { impl, calls } = recordingFetch();
  const session = new WhepSession({ fetchImpl: impl, peerConnectionImpl: FakePeerConnection });

  await session.start(ACCESS);
  await session.stop();
  await session.stop();

  assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
});

test("a rejected credential is reported as such, not as a network problem", async () => {
  let created;
  const session = new WhepSession({
    fetchImpl: () => Promise.resolve(answer({ status: 401 })),
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        created = this;
      }
    },
  });

  const result = await session.start(ACCESS);

  assert.deepEqual(result, { ok: false, reason: WhepFailure.Unauthorized });
  assert.equal(created.closed, true, "a failed negotiation must not leave a connection open");
});

test("each failure keeps its own reason", async () => {
  const cases = [
    [404, WhepFailure.NotFound],
    [500, WhepFailure.Refused],
    [403, WhepFailure.Unauthorized],
  ];

  for (const [status, reason] of cases) {
    const session = new WhepSession({
      fetchImpl: () => Promise.resolve(answer({ status })),
      peerConnectionImpl: FakePeerConnection,
    });
    assert.deepEqual(await session.start(ACCESS), { ok: false, reason });
  }
});

test("an unreachable router is not the same failure as a refused one", async () => {
  const session = new WhepSession({
    fetchImpl: () => Promise.reject(new TypeError("failed to fetch")),
    peerConnectionImpl: FakePeerConnection,
  });

  assert.deepEqual(await session.start(ACCESS), { ok: false, reason: WhepFailure.Unreachable });
});

test("starting without access is refused before a connection is built", async () => {
  let constructed = 0;
  const session = new WhepSession({
    fetchImpl: () => assert.fail("no request may be made without a credential"),
    peerConnectionImpl: class extends FakePeerConnection {
      constructor(config) {
        super(config);
        constructed += 1;
      }
    },
  });

  assert.deepEqual(
    await session.start({ url: ACCESS.url, authorization: null }),
    { ok: false, reason: WhepFailure.NoAccess },
  );
  assert.equal(constructed, 0);
});

test("a browser without WebRTC is reported rather than crashed into", async () => {
  const session = new WhepSession({
    fetchImpl: () => assert.fail("nothing to request"),
    peerConnectionImpl: null,
  });

  // peerConnectionImpl: null falls back to globalThis.RTCPeerConnection, which node does not have.
  assert.deepEqual(await session.start(ACCESS), { ok: false, reason: WhepFailure.Unsupported });
});

test("a router that names no session resource still negotiates", async () => {
  const { impl, calls } = recordingFetch(answer({ location: null }));
  const session = new WhepSession({ fetchImpl: impl, peerConnectionImpl: FakePeerConnection });

  assert.deepEqual(await session.start(ACCESS), { ok: true });

  await session.stop();
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
});

test("gathering that is still in flight is waited for, and does not hang forever", async () => {
  const listeners = [];
  class Gathering extends FakePeerConnection {
    constructor(config) {
      super(config);
      this.iceGatheringState = "gathering";
    }

    addEventListener(name, handler) {
      listeners.push({ name, handler });
    }

    removeEventListener() {}
  }

  const { impl, calls } = recordingFetch();
  const session = new WhepSession({ fetchImpl: impl, peerConnectionImpl: Gathering });
  const started = session.start(ACCESS);

  // Nothing is posted until the candidates are in. Drained rather than a fixed number of microtasks:
  // the offer and the local description are awaited first, and counting those ticks here would make the
  // test fail on an implementation detail rather than on the behaviour.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);

  const pc = listeners[0];
  assert.equal(pc.name, "icegatheringstatechange");
  session._pc.iceGatheringState = "complete";
  pc.handler();

  assert.deepEqual(await started, { ok: true });
  assert.equal(calls.length, 1);
});

test("stop aborts an in-flight WHEP POST and closes the peer", async () => {
  let entered;
  const fetching = new Promise(resolve => { entered = resolve; });
  let signal;
  const session = new WhepSession({ peerConnectionImpl: FakePeerConnection, fetchImpl: async (_, options) => {
    signal = options.signal;
    entered();
    return await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  } });
  const starting = session.start(ACCESS);
  await fetching;
  const peer = session._pc;
  await session.stop();
  assert.equal(signal.aborted, true);
  assert.equal(peer.closed, true);
  assert.equal((await starting).ok, false);
});

test("a late successful POST after cancellation deletes the orphan session", async () => {
  let entered, release;
  const fetching = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const session = new WhepSession({ peerConnectionImpl: FakePeerConnection, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "POST") { entered(); return await pending; }
    return answer();
  } });
  const starting = session.start(ACCESS);
  await fetching; await session.stop(); release(answer());
  assert.equal((await starting).ok, false);
  assert.equal(session.isActive, false);
  const deletes = calls.filter(call => call.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].redirect, "error");
  assert.equal(deletes[0].credentials, "omit");
  await session.stop();
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
});
