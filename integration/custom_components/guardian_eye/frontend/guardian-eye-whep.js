/**
 * WHEP client for the Guardian Eye camera card.
 *
 * Owner decision O-7(a): our own client rather than an iframe around the router's built-in player. The
 * iframe would be quicker and would cost us the theme, the eighteen locales, every error message and any
 * ability to say why a stream is not playing.
 *
 * Facts this encodes, measured against the pinned MediaMTX v1.20.1 rather than taken from documentation:
 *
 *   - Credentials must travel in a header. `?user=&pass=` query parameters are rejected with 401.
 *   - Both `Authorization: Basic` and `Authorization: Bearer <user>:<pass>` are accepted. The backend hands
 *     us a ready-made Bearer header: Basic would make the browser treat the router as an HTTP-auth realm,
 *     caching the credential and popping a native login dialog on any navigation to the same origin.
 *   - The CORS preflight allows `Authorization`, `Content-Type` and `If-Match`, and the methods
 *     `OPTIONS, GET, POST, PATCH, DELETE` — so cross-origin playback works with a header, and the session
 *     can be torn down with a DELETE on the resource the router names in `Location`.
 *
 * No Home Assistant dependency on purpose: this file is the piece worth testing under node, and every
 * dependency on `hass` would have to be faked to do it.
 */

/** Reason codes the card renders. Stable strings, matched by the localisation keys. */
export const WhepFailure = {
  NoAccess: "no_access",
  Unauthorized: "unauthorized",
  NotFound: "not_found",
  Unreachable: "unreachable",
  MixedContent: "mixed_content",
  Unsupported: "unsupported",
  Refused: "refused",
  ConnectionFailed: "connection_failed",
};

/**
 * A page served over HTTPS cannot fetch an HTTP router; the browser blocks it before any request is made.
 * Detected up front because the resulting failure is otherwise a bare network error, and "your dashboard
 * is HTTPS and the router is not" is not something anyone guesses from that.
 */
export function isMixedContent(pageProtocol, whepUrl) {
  if (pageProtocol !== "https:") {
    return false;
  }
  try {
    return new URL(whepUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * One WHEP session: an offer, an answer, and a resource to delete when done.
 *
 * Deliberately single-use. Reconnecting means constructing a new one — a peer connection that has failed
 * carries state that is easier to throw away than to reason about.
 */
export class WhepSession {
  /**
   * @param {object} options
   * @param {typeof fetch} [options.fetchImpl] injected for tests
   * @param {typeof RTCPeerConnection} [options.peerConnectionImpl] injected for tests
   * @param {string[]} [options.iceServers] STUN/TURN URLs; empty by default, like the backend
   */
  constructor({ fetchImpl, peerConnectionImpl, iceServers = [] } = {}) {
    this._fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this._PeerConnection = peerConnectionImpl ?? globalThis.RTCPeerConnection;
    this._iceServers = iceServers;
    this._pc = null;
    this._resourceUrl = null;
    this._closed = false;
    this._startAbort = null;
  }

  get isActive() {
    return this._pc !== null && !this._closed;
  }

  /**
   * Negotiates playback and attaches the incoming track to a media element.
   *
   * ⚠️ Returning <code>ok</code> means the offer was answered, not that media is flowing. Everything after
   * the SDP exchange — ICE, DTLS — happens later and can still fail, and it does: Firefox declines
   * loopback candidates outright, so a viewer on the same machine as Guardian Eye configured with
   * 127.0.0.1 negotiates perfectly and then connects to nothing. Without <code>onFailed</code> the caller
   * shows a black rectangle and says nothing, which is the single most common complaint about camera
   * dashboards and the thing this card was written to avoid.
   *
   * @param {(reason: string) => void} [options.onFailed] called if the connection fails after negotiation.
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>} never throws: this runs from a card's
   *   render path, and an exception there takes the whole dashboard tile with it.
   */
  async start({ url, authorization, mediaElement, onFailed }) {
    if (this._closed) return { ok: false, reason: WhepFailure.Unreachable };
    if (!url || !authorization) {
      return { ok: false, reason: WhepFailure.NoAccess };
    }
    if (!this._PeerConnection) {
      return { ok: false, reason: WhepFailure.Unsupported };
    }
    if (isMixedContent(globalThis.location?.protocol, url)) {
      return { ok: false, reason: WhepFailure.MixedContent };
    }

    const pc = new this._PeerConnection({
      iceServers: this._iceServers.map((entry) => ({ urls: entry })),
    });
    this._pc = pc;
    const controller = new AbortController();
    this._startAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);

    // recvonly on both, declared before the offer: the router answers with whatever the publication
    // carries, and a video-only stream is the normal case rather than an error.
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    if (onFailed) {
      pc.addEventListener("connectionstatechange", () => {
        // `failed` only. `disconnected` is transient by definition — ICE says so — and tearing a stream
        // down on a momentary blip would be worse than the blip.
        if (pc.connectionState === "failed" && !this._closed) {
          onFailed(WhepFailure.ConnectionFailed);
        }
      });
    }

    if (mediaElement) {
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream && mediaElement.srcObject !== stream) {
          mediaElement.srcObject = stream;
        }
      };
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (controller.signal.aborted || this._closed) throw new Error("cancelled");

      const response = await this._fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          Authorization: authorization,
        },
        body: pc.localDescription?.sdp ?? offer.sdp,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });

      if (!response.ok) {
        await this.stop();
        return { ok: false, reason: statusToReason(response.status) };
      }

      // The router names the session resource here. Without it there is no way to hang up politely, and
      // the publication keeps a reader attached until it times out.
      //
      // Resolved against the URL we chose and pinned to its origin: the DELETE carries the credential, and
      // a Location pointing elsewhere would be the same theft the endpoint check above prevents — just one
      // step later and from a server that has already answered once.
      const location = response.headers?.get?.("Location");
      this._resourceUrl = location ? resolveSameOrigin(url, location) : null;
      this._authorization = authorization;

      if (controller.signal.aborted || this._closed) throw new Error("cancelled");
      await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
      if (controller.signal.aborted || this._closed) throw new Error("cancelled");
      return { ok: true };
    } catch {
      await this.stop();
      return { ok: false, reason: WhepFailure.Unreachable };
    } finally {
      clearTimeout(timeout);
      this._startAbort = null;
    }
  }

  /**
   * Ends the session.
   *
   * The DELETE is best-effort and the peer connection is closed either way: a card being removed from the
   * DOM must not leave a live connection behind because the router did not answer.
   */
  async stop() {
    this._closed = true;
    this._startAbort?.abort();

    const resourceUrl = this._resourceUrl;
    const authorization = this._authorization;
    this._resourceUrl = null;
    this._authorization = null;

    const pc = this._pc;
    this._pc = null;
    if (pc) {
      pc.ontrack = null;
      try {
        pc.close();
      } catch {
        // Already closed, or closed by the browser. Nothing left to do either way.
      }
    }

    if (!resourceUrl) {
      return;
    }

    try {
      await this._fetch(resourceUrl, {
        method: "DELETE",
        headers: authorization ? { Authorization: authorization } : undefined,
        signal: AbortSignal.timeout(3000),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      // The router is gone or unreachable; it drops the session on its own timeout.
    }
  }
}

/**
 * Waits until the browser has gathered its candidates, or gives up.
 *
 * Non-trickle on purpose: WHEP allows trickle over PATCH, but a single self-contained POST is far less to
 * go wrong across proxies, and on a loopback or LAN router gathering finishes in milliseconds. The timeout
 * exists because a host with an unreachable STUN server would otherwise never finish gathering, and the
 * candidates already collected are usually enough.
 */
function waitForIceGathering(pc, timeoutMs = 2000) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pc.removeEventListener?.("icegatheringstatechange", onChange);
      resolve();
    };

    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener?.("icegatheringstatechange", onChange);
  });
}

/**
 * Resolves a router-supplied reference against the URL we posted to, refusing anything that leaves it.
 *
 * Unlike the endpoint, a Location may legitimately be relative or absolute — the spec allows both — so the
 * check is on the resulting origin rather than on the shape.
 */
function resolveSameOrigin(baseUrl, reference) {
  try {
    const resolved = new URL(reference, baseUrl);
    return resolved.origin === new URL(baseUrl).origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function statusToReason(status) {
  if (status === 401 || status === 403) {
    return WhepFailure.Unauthorized;
  }
  if (status === 404) {
    return WhepFailure.NotFound;
  }
  return WhepFailure.Refused;
}
