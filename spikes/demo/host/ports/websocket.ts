// VENDORED from polymorph-websocket/js/deltic/websocket.ts and
// mechanically migrated to the deltic 0.1.0 embedder conventions:
// WitError -> ComponentException, variant envelopes {tag, val} ->
// {kind, value}. The sibling repo still pins the pre-release embedder
// through its own deno.json (module-identity constraint violation when
// consumed from a 0.1.0 graph) -- migrating upstream retires this copy.
// Host module for `polymorph:websocket/connections@0.1.0`, ported to the
// deltic embedder conventions (contracts/embedder-api.md).
//
// PORT PROVENANCE. This is a faithful translation of the consumer's
// browser-first reference host, `polymorph-websocket/js/jco/websocket.js`
// **at commit c9252be** — the file was retired with the jco legs, so the
// `websocket.js:LINE` citations below read against that revision
// (`git show c9252be:js/jco/websocket.js`). That reference host's
// behavior is what this repo's conformance suite asserts, and this module
// now carries every JS-host row of the matrix. The LOGIC — timeout defaults, buffer bounds,
// close-code validation, subprotocol validation, overflow-close
// behavior, the receive-via-stream single-use rule — is preserved
// line-for-line; only the *conventions* are translated:
//
//   the retired jco host                 | this port
//   -------------------------------------+------------------------------------
//   `throw { tag, val }` (bare payload)   | `throw new WitError({ tag, val })`
//   jco `Stream` (`read({count})`)        | `Stream<T>` / `ReadableStream`
//   module-namespace `--map` wiring       | `websocketImports()` record fragment
//   module-level setters                  | `configure()` + compatible setters
//
// The WIT contract is `polymorph-websocket/wit/websocket.wit`; every
// doc comment below that quotes a contract quotes that file.
//
// Runtime: Deno's native `WebSocket` (the W3C API). The module reads no
// ambient configuration — no environment variables, no globals — exactly
// as the reference does (websocket.js:57-63).

import {
  ComponentException as WitError,
  Stream,
  type StreamSource,
} from "@deltic/runtime/embedder";

// ----- WIT value types (contracts/embedder-api.md §"Value mapping") ---------

/** `types.error` — a variant; `val` is absent for payloadless cases. */
export type WebsocketError =
  | { kind: "invalid-url"; value: string }
  | { kind: "connect-failed"; value: string }
  | { kind: "closed" }
  | { kind: "receiving-via-stream" }
  | { kind: "receive-buffer-overflow" }
  | { kind: "invalid-argument"; value: string }
  | { kind: "other"; value: string };

/**
 * `types.message` — `variant { binary(list<u8>), %string(string) }`.
 *
 * The WIT case name is `%string`; `%` is WIT's identifier escape, not part
 * of the name, so the conventions' "kebab-case verbatim" tag is `"string"`.
 */
export type Message =
  | { kind: "binary"; value: Uint8Array }
  | { kind: "string"; value: string };

/** `types.message-kind` — an enum, so a string-literal union. */
export type MessageKind = "binary" | "string";

/** `types.stream-message`. `data` is a `stream<u8>`. */
export interface StreamMessage {
  kind: MessageKind;
  length: number;
  data: StreamSource<number>;
}

/** The lifted shape of `stream-message` when the guest hands one over. */
interface LiftedStreamMessage {
  kind: MessageKind;
  length: number;
  data: Stream<number>;
}

/** `types.send-via-stream-error`. `sent` is a `u64`, hence `bigint`. */
export interface SendViaStreamError {
  error: WebsocketError;
  sent: bigint;
}

/** `types.close-info`. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/** `types.websocket-state` — an enum. */
export type WebsocketState = "open" | "closing" | "closed";

/** Throw a WIT `error` the branded way (contracts/embedder-api.md §"Error model"). */
function witError(payload: WebsocketError): WitError<WebsocketError> {
  return new WitError<WebsocketError>(
    payload,
    payload.kind + ("value" in payload ? `: ${payload.value}` : ""),
  );
}

// ----- configuration -------------------------------------------------------
// Defaults are the reference module's, byte for byte (websocket.js:25-50).

/** How long `connect` waits for the handshake before failing `connect-failed`
 *  (the WIT leaves the bound implementation-defined). websocket.js:27. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** How long a locally initiated close may wait for the peer's acknowledgement
 *  before the resource settles as closed anyway. websocket.js:33. */
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;

/** The default bound on buffered inbound payload bytes awaiting `receive`.
 *  websocket.js:41. */
const DEFAULT_MAX_INBOUND_BUFFERED = 8 * 1024 * 1024;

/** Keep the send buffer bounded; pause the producer while it drains.
 *  `WebSocket` has no `bufferedamountlow` event, so draining is polled.
 *  websocket.js:46-47. */
const MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;
const DRAIN_POLL_MS = 4;

/** Batch size for reads from a guest byte stream. websocket.js:50. */
const READ_BATCH = 65536;

/** The configured knobs; connections capture them at `connect`. websocket.js:53-55. */
let maxInboundBuffered = DEFAULT_MAX_INBOUND_BUFFERED;
let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
let closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS;

/** The options surface the conventions prefer; every field is optional. */
export interface WebsocketOptions {
  /** Per-connection inbound buffer bound, in payload bytes. */
  maxInboundBufferBytes?: number;
  /** The `connect` handshake bound, in milliseconds. */
  connectTimeoutMs?: number;
  /** The closing-handshake bound, in milliseconds. */
  closeTimeoutMs?: number;
}

/**
 * Apply configuration. Like the reference module, this reads no ambient
 * configuration: a host that offers these as knobs reads and validates the
 * values itself. Throws (a plain `Error` — this is a host-side API, not a
 * guest-visible boundary) on anything but positive finite numbers.
 */
export function configure(options: WebsocketOptions): void {
  if (options.maxInboundBufferBytes !== undefined) {
    setMaxInboundBufferBytes(options.maxInboundBufferBytes);
  }
  if (options.connectTimeoutMs !== undefined) {
    setConnectTimeoutMs(options.connectTimeoutMs);
  }
  if (options.closeTimeoutMs !== undefined) {
    setCloseTimeoutMs(options.closeTimeoutMs);
  }
}

/** The current configuration (a copy). */
export function currentConfig(): Required<WebsocketOptions> {
  return {
    maxInboundBufferBytes: maxInboundBuffered,
    connectTimeoutMs,
    closeTimeoutMs,
  };
}

/** Reset every knob to the reference module's defaults. */
export function resetConfig(): void {
  maxInboundBuffered = DEFAULT_MAX_INBOUND_BUFFERED;
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS;
}

/** Set the per-connection inbound buffer bound, in payload bytes.
 *  Signature-compatible with websocket.js:64. */
export function setMaxInboundBufferBytes(bytes: number): void {
  if (!(Number.isFinite(bytes) && bytes > 0)) {
    throw new Error(
      `invalid inbound buffer bound ${bytes}: expected a positive byte count`,
    );
  }
  maxInboundBuffered = bytes;
}

/** Set the `connect` handshake bound, in milliseconds. websocket.js:72. */
export function setConnectTimeoutMs(ms: number): void {
  if (!(Number.isFinite(ms) && ms > 0)) {
    throw new Error(`invalid connect timeout ${ms}: expected positive milliseconds`);
  }
  connectTimeoutMs = ms;
}

/** Set the closing-handshake bound, in milliseconds. websocket.js:80. */
export function setCloseTimeoutMs(ms: number): void {
  if (!(Number.isFinite(ms) && ms > 0)) {
    throw new Error(`invalid close timeout ${ms}: expected positive milliseconds`);
  }
  closeTimeoutMs = ms;
}

// ----- validation (websocket.js:87-176, verbatim logic) --------------------

const utf8 = new TextEncoder();

/** The UTF-8 byte length of a string (the WIT bounds count bytes). */
function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

/**
 * Whether `token` is a valid RFC 6455 subprotocol token (an RFC 2616
 * `token`: 1+ US-ASCII characters, no separators or control characters).
 * websocket.js:97.
 */
function isValidProtocolToken(token: string): boolean {
  if (!token.length) return false;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f) return false;
    if ('"(),/:;<=>?@[\\]{}'.includes(token[i])) return false;
  }
  return true;
}

/** Validate a connect URL per the WIT contract; throws `invalid-url`. */
function validateUrl(url: string): void {
  if (url.includes("#")) {
    throw witError({ kind: "invalid-url", value: "URL must not have a fragment" });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw witError({
      kind: "invalid-url",
      value: `URL does not parse: ${(err as Error)?.message ?? err}`,
    });
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw witError({
      kind: "invalid-url",
      value: `URL scheme must be ws or wss, not ${JSON.stringify(parsed.protocol)}`,
    });
  }
  if (!parsed.hostname) {
    throw witError({ kind: "invalid-url", value: "URL must have a host" });
  }
  // The WHATWG WebSocket constructor rejects credentials in the URL; the
  // eager taxonomy matches that floor uniformly. websocket.js:127-131.
  if (parsed.username || parsed.password) {
    throw witError({ kind: "invalid-url", value: "URL must not have userinfo" });
  }
}

/** Validate a subprotocol offer per the WIT contract; throws `invalid-argument`. */
function validateProtocols(protocols: string[]): void {
  for (let i = 0; i < protocols.length; i += 1) {
    const protocol = protocols[i];
    if (!isValidProtocolToken(protocol)) {
      throw witError({
        kind: "invalid-argument",
        value: `subprotocol ${JSON.stringify(protocol)} is not a valid token`,
      });
    }
    if (protocols.indexOf(protocol) !== i) {
      throw witError({
        kind: "invalid-argument",
        value: `subprotocol ${JSON.stringify(protocol)} is offered twice`,
      });
    }
  }
}

/**
 * Validate close arguments per the WIT contract: `code` 1000 or 3000-4999,
 * `reason` at most 123 UTF-8 bytes and only alongside a code. Throws
 * `invalid-argument`. websocket.js:158.
 */
function validateCloseArgs(code: number | undefined, reason: string): void {
  if (code !== undefined && code !== null) {
    if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
      throw witError({
        kind: "invalid-argument",
        value: `close code must be 1000 or in 3000-4999, not ${code}`,
      });
    }
  } else if (reason.length) {
    throw witError({
      kind: "invalid-argument",
      value: "a close reason requires a close code",
    });
  }
  const bytes = utf8ByteLength(reason);
  if (bytes > 123) {
    throw witError({
      kind: "invalid-argument",
      value: `close reason must be at most 123 bytes, got ${bytes}`,
    });
  }
}

// ----- the resource --------------------------------------------------------

/**
 * Close codes that are *synthesized by the platform* and never carried by a
 * close frame, so they mean "the peer sent no close frame" — see
 * `Websocket.#settleClosed` for the full rationale, including the Deno `0`.
 */
const SYNTHESIZED_CLOSE_CODES = new Set([0, 1006, 1015]);

interface IncomingQueue {  next(): Promise<Message>;
  rejectWaiters(error: WebsocketError): void;
  end(): void;
  discard(): void;
}

/**
 * The `websocket` resource: an open WebSocket client connection over the
 * standard `WebSocket` API. A host-implemented resource class per
 * contracts/embedder-api.md §"Resources": methods camelCase, the WIT
 * static as a static member, `[Symbol.dispose]` as the dtor.
 */
export class Websocket {
  #ws: WebSocket;
  #incoming: IncomingQueue;
  /** Set by a local `close()` (or dispose): the close is observed locally
   *  at once and the unread backlog is discarded. */
  #localClosed = false;
  /** Set once `receive-via-stream` has claimed the inbound messages. */
  #streamClaimed = false;
  /** Whether `wait-closed` has settled. */
  #closeSettled = false;
  #closeInfo: CloseInfo | undefined = undefined;
  #closeWaiters: ((info: CloseInfo | undefined) => void)[] = [];
  #closeDeadline: ReturnType<typeof setTimeout> | null = null;

  /**
   * `connect: static async func(url, protocols) -> result<websocket, error>`.
   * Resolves with a `Websocket` once the handshake completes; throws
   * `WitError<WebsocketError>` on failure. websocket.js:203.
   */
  static async connect(url: string, protocols: string[]): Promise<Websocket> {
    validateUrl(url);
    validateProtocols(protocols);

    let ws: WebSocket;
    try {
      ws = protocols.length ? new WebSocket(url, protocols) : new WebSocket(url);
    } catch (err) {
      // Eager validation covered the SyntaxError cases; anything left is a
      // platform policy refusing the connection.
      throw witError({
        kind: "connect-failed",
        value: String((err as Error)?.message ?? err),
      });
    }
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (fn: (v?: unknown) => void, value?: unknown) => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        fn(value);
      };
      const onOpen = () => settle(resolve as (v?: unknown) => void);
      // Platforms deliberately hide connect-failure diagnostics; the close
      // code is all there is, and it is usually 1006. websocket.js:227-233.
      const onClose = (event: Event) => {
        const ce = event as CloseEvent;
        settle(
          reject,
          witError({
            kind: "connect-failed",
            value: ce.reason || `connection failed (code ${ce.code})`,
          }),
        );
      };
      const onError = () => {
        // An `error` event is always followed by `close`; wait for it so
        // the reason (if any) rides along.
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("close", onClose, { once: true });
      ws.addEventListener("error", onError, { once: true });
      timer = setTimeout(() => {
        settle(
          reject,
          witError({
            kind: "connect-failed",
            value: `handshake timed out after ${connectTimeoutMs}ms`,
          }),
        );
        try {
          ws.close();
        } catch {
          // Nothing to reclaim.
        }
      }, connectTimeoutMs);
    });

    // The platform enforces the offer contract natively; these guards keep
    // the taxonomy identical on runtimes that are lax about it.
    // websocket.js:256-279.
    if (protocols.length && !protocols.includes(ws.protocol)) {
      try {
        ws.close();
      } catch { /* already closing */ }
      throw witError({
        kind: "connect-failed",
        value: ws.protocol
          ? `server selected subprotocol ${JSON.stringify(ws.protocol)} which was not offered`
          : "server selected no subprotocol although one was offered",
      });
    }
    if (!protocols.length && ws.protocol) {
      try {
        ws.close();
      } catch { /* already closing */ }
      throw witError({
        kind: "connect-failed",
        value: `server selected subprotocol ${
          JSON.stringify(ws.protocol)
        } although none was offered`,
      });
    }

    return new Websocket(ws);
  }

  /** @param ws an OPEN `WebSocket` */
  constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#incoming = incomingQueue(ws, () => this.#transportClosing());
    ws.addEventListener("close", (event) => this.#settleClosed(event as CloseEvent), {
      once: true,
    });
    // `error` without `close` does not happen per spec; the close listener
    // is the single settle point.
    ws.addEventListener("error", () => {}, { once: true });
  }

  /** `protocol: func() -> string` — the negotiated subprotocol, or "". */
  protocol(): string {
    return this.#ws.protocol;
  }

  /**
   * `send: async func(message) -> result<_, error>`. Resolves once the
   * message is handed to the transport; throws `closed` once a close was
   * initiated (locally or by the peer) — messages are never silently
   * discarded. websocket.js:305.
   */
  async send(message: Message): Promise<void> {
    for (;;) {
      if (this.#localClosed || this.#ws.readyState !== WebSocket.OPEN) {
        throw witError({ kind: "closed" });
      }
      if (this.#ws.bufferedAmount <= MAX_BUFFERED_AMOUNT) break;
      // No `bufferedamountlow` on WebSocket: poll the drain.
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    try {
      // `<ArrayBuffer>` (the dom-lib `send` signature excludes SAB-backed
      // views): a guest-lifted `list<u8>` is always a fresh copy
      // (contracts/embedder-api.md §"Value mapping"), never SAB-backed.
      this.#ws.send(message.value as string | Uint8Array<ArrayBuffer>);
    } catch (err) {
      throw witError({ kind: "other", value: String((err as Error)?.message ?? err) });
    }
  }

  /**
   * `receive: async func() -> result<message, error>`. Throws the WIT
   * `error` once the connection closes. websocket.js:325.
   */
  receive(): Promise<Message> {
    if (this.#localClosed) return Promise.reject(witError({ kind: "closed" }));
    if (this.#streamClaimed) {
      return Promise.reject(witError({ kind: "receiving-via-stream" }));
    }
    return this.#incoming.next();
  }

  /**
   * `send-via-stream: async func(stream<stream-message>) -> result<_, send-via-stream-error>`.
   * Throws `WitError<SendViaStreamError>`. websocket.js:336.
   */
  async sendViaStream(messages: Stream<LiftedStreamMessage>): Promise<void> {
    let sent = 0n;
    try {
      for await (const item of streamItems(messages)) {
        // Buffering is bounded by the declared length; bytes past it are
        // counted, not stored, so a mis-declared length cannot grow host
        // memory without bound. websocket.js:341-349.
        const { bytes, excess } = await collectByteStream(item.data, item.length);
        if (excess > 0 || bytes.length !== item.length) {
          throw witError({
            kind: "other",
            value: `stream-message payload was ${
              bytes.length + excess
            } bytes but length declared ${item.length}`,
          });
        }
        let message: Message;
        if (item.kind === "string") {
          // The payload must be valid UTF-8, per the streaming contract; a
          // lossy decode would silently send mangled text.
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw witError({
              kind: "other",
              value: "string stream-message payload is not valid UTF-8",
            });
          }
          message = { kind: "string", value: text };
        } else {
          message = { kind: "binary", value: bytes };
        }
        await this.send(message);
        sent += 1n;
      }
    } catch (error) {
      // A WIT error variant passes through; anything else is a host-side
      // failure and must not masquerade as a normal close. websocket.js:370-378.
      const payload: WebsocketError = error instanceof WitError
        ? error.payload as WebsocketError
        : { kind: "other", value: String(error) };
      throw new WitError<SendViaStreamError>(
        { error: payload, sent },
        `send-via-stream failed after ${sent} message(s)`,
      );
    }
  }

  /**
   * `receive-via-stream: func() -> result<stream<stream-message>, error>`.
   * Once-only: a second call (or any later `receive`) throws
   * `receiving-via-stream`, and any pending `receive` is rejected with it.
   * The stream ends when the connection closes. websocket.js:388.
   *
   * Returns a `ReadableStream`, one of the natural JS producers the
   * conventions accept where a `stream<T>` is expected
   * (contracts/embedder-api.md §"Streams and futures").
   */
  receiveViaStream(): ReadableStream<StreamMessage> {
    if (this.#localClosed) throw witError({ kind: "closed" });
    if (this.#streamClaimed) throw witError({ kind: "receiving-via-stream" });
    this.#streamClaimed = true;
    const incoming = this.#incoming;
    incoming.rejectWaiters({ kind: "receiving-via-stream" });
    return new ReadableStream<StreamMessage>({
      async pull(controller) {
        let message: Message;
        try {
          message = await incoming.next();
        } catch {
          // The connection closed (or its inbound buffer overflowed): the
          // stream simply ends, per the WIT contract.
          controller.close();
          return;
        }
        const bytes = message.kind === "string"
          ? new TextEncoder().encode(message.value)
          : message.value;
        controller.enqueue({
          kind: message.kind,
          length: bytes.length,
          data: bytesToStream(bytes),
        });
      },
    });
  }

  /** `state: func() -> websocket-state`. `closed` is terminal and latched. */
  state(): WebsocketState {
    return this.#currentState();
  }

  /**
   * `wait-closed: async func() -> option<close-info>`. Latched: every call
   * resolves with the same value. `option` in the outermost position maps
   * to `T | undefined` (contracts/embedder-api.md §"Value mapping").
   */
  waitClosed(): Promise<CloseInfo | undefined> {
    if (this.#closeSettled) return Promise.resolve(this.#closeInfo);
    return new Promise((resolve) => this.#closeWaiters.push(resolve));
  }

  /**
   * `close: func(code: option<u16>, reason: string) -> result<_, error>` —
   * deliberately synchronous. Validate eagerly, then initiate the closing
   * handshake and return. Idempotent after the first accepted call.
   * websocket.js:441.
   */
  close(code: number | undefined, reason: string): void {
    validateCloseArgs(code, reason);
    if (this.#localClosed) return;
    this.#localClosed = true;
    this.#incoming.discard();
    // The resource settles as closed within the close bound even when the
    // peer never acknowledges.
    this.#closeDeadline = setTimeout(() => this.#settleClosed(null), closeTimeoutMs);
    try {
      if (code === undefined || code === null) {
        this.#ws.close();
      } else if (reason.length) {
        this.#ws.close(code, reason);
      } else {
        this.#ws.close(code);
      }
    } catch {
      // Validation covered the argument errors; per the WIT contract the
      // close result reflects arguments only, and the deadline above
      // already bounds the teardown, so a platform throw past this point
      // must not surface.
    }
  }

  /**
   * The dtor the runtime invokes when the guest drops its last own handle
   * (contracts/embedder-api.md §"Resources"): dropping without `close`
   * implies `close(none, "")`, per the WIT contract.
   */
  [Symbol.dispose](): void {
    try {
      this.close(undefined, "");
    } catch {
      // Already closed.
    }
  }

  /**
   * A close was initiated below the resource (an inbound-buffer overflow):
   * bound the teardown. Unlike a guest-initiated `close`, the receivable
   * backlog is kept — overflow readers drain it before observing the
   * overflow error. websocket.js:483.
   */
  #transportClosing(): void {
    if (!this.#closeSettled && this.#closeDeadline === null) {
      this.#closeDeadline = setTimeout(() => this.#settleClosed(null), closeTimeoutMs);
    }
  }

  #currentState(): WebsocketState {
    if (this.#closeSettled) return "closed";
    if (this.#localClosed) return "closing";
    switch (this.#ws.readyState) {
      case WebSocket.CLOSING:
        return "closing";
      case WebSocket.CLOSED:
        return "closed";
      default:
        return "open";
    }
  }

  /**
   * Settle the close outcome. `event` is the `CloseEvent`, or `null` when
   * the close bound expired first. Codes 1006 (abnormal) and 1015 (TLS
   * failure) are synthesized by the platform, never carried by a frame, so
   * they map to "no close-info", per the WIT close contract
   * (wit/websocket.wit:106-118: "A `close-info` exists only when the peer
   * actually sent a close frame ... and implementations never invent one").
   * websocket.js:508.
   *
   * DENO DELTA (the one behavioral divergence from the reference host).
   * On an abnormal closure — the peer drops TCP with no close frame —
   * browsers and Node deliver `CloseEvent.code === 1006`, but **Deno
   * delivers `0`** (verified empirically against the suite's own
   * `/abrupt-close` endpoint: `{code: 0, reason: "", wasClean: false}`,
   * versus `{code: 4001, wasClean: true}` for a real close frame on the
   * same runtime). Code 0 is not a wire value at all — no frame carried
   * it — so it belongs in exactly the same bucket as 1006. Without this,
   * `websocket/close/abnormal` and `websocket/tls/abrupt-close` fail with
   * "abnormal closure produced close-info code=0".
   *
   * 1005 is deliberately NOT in the set: it is the legitimate observation
   * of a close frame that carried no code (wit/websocket.wit:113-115), and
   * the suite asserts `close-info{code: 1005}` for it
   * (`close/local-default`, `close/remote-no-code`).
   */
  #settleClosed(event: CloseEvent | null): void {
    if (this.#closeSettled) return;
    this.#closeSettled = true;
    if (this.#closeDeadline !== null) {
      clearTimeout(this.#closeDeadline);
      this.#closeDeadline = null;
    }
    // A settle without a close event (the deadline path) must still end
    // the inbound queue, or a pending receive would hang past the close.
    this.#incoming.end();
    if (event && !SYNTHESIZED_CLOSE_CODES.has(event.code)) {
      this.#closeInfo = { code: event.code, reason: event.reason ?? "" };
    } else {
      this.#closeInfo = undefined;
    }
    const waiters = this.#closeWaiters;
    this.#closeWaiters = [];
    for (const resolve of waiters) resolve(this.#closeInfo);
  }
}

// ----- helpers -------------------------------------------------------------

/**
 * Build a per-message inbound queue over `ws` (websocket.js:543).
 *
 * Buffering is bounded (in payload bytes): a message that would exceed the
 * bound closes the connection — reported through `onOverflowClose` so the
 * owning resource can bound the teardown — and discards that and any later
 * messages; the pre-overflow backlog stays deliverable, after which
 * `next()` rejects with `receive-buffer-overflow`.
 */
function incomingQueue(ws: WebSocket, onOverflowClose: () => void): IncomingQueue {
  // Captured at construction: connections capture the knobs at `connect`.
  const limit = maxInboundBuffered;
  const messages: { message: Message; size: number }[] = [];
  const waiters: {
    resolve: (m: Message) => void;
    reject: (e: unknown) => void;
  }[] = [];
  let buffered = 0;
  let overflowed = false;
  let closed = false;

  const push = (message: Message, size: number) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(message);
    } else {
      buffered += size;
      messages.push({ message, size });
    }
  };

  ws.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (overflowed) return;
    // Account string payloads in UTF-8 bytes (the WIT bound counts payload
    // bytes; `.length` would count UTF-16 code units).
    const size = typeof data === "string"
      ? utf8ByteLength(data)
      : (data as ArrayBuffer).byteLength;
    // The bound applies to queued bytes: a pending waiter implies an empty
    // queue (`buffered` is 0), so this reduces to `size > limit` then — a
    // single message larger than the whole bound overflows even when a
    // receiver is waiting for it, matching the wasmtime host.
    // websocket.js:566-582.
    if (buffered + size > limit) {
      overflowed = true;
      try {
        ws.close();
      } catch { /* already closing */ }
      onOverflowClose();
      return;
    }
    const message: Message = typeof data === "string"
      ? { kind: "string", value: data }
      : { kind: "binary", value: new Uint8Array(data as ArrayBuffer) };
    push(message, size);
  });

  const endError = (): WebsocketError =>
    overflowed ? { kind: "receive-buffer-overflow" } : { kind: "closed" };
  const end = () => {
    if (closed) return;
    closed = true;
    while (waiters.length) {
      waiters.shift()!.reject(witError(endError()));
    }
  };
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);

  return {
    next(): Promise<Message> {
      if (messages.length) {
        const { message, size } = messages.shift()!;
        buffered -= size;
        return Promise.resolve(message);
      }
      if (overflowed) {
        return Promise.reject(witError({ kind: "receive-buffer-overflow" }));
      }
      if (closed) return Promise.reject(witError({ kind: "closed" }));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    rejectWaiters(error: WebsocketError) {
      while (waiters.length) {
        waiters.shift()!.reject(witError(error));
      }
    },
    end,
    /** Discard the unread backlog and fail pending and future reads
     *  `closed` (a local `close`, per the WIT contract). */
    discard() {
      messages.length = 0;
      buffered = 0;
      closed = true;
      while (waiters.length) {
        waiters.shift()!.reject(witError({ kind: "closed" }));
      }
    },
  };
}

/**
 * Iterate a guest-provided WIT stream. The conventions hand the host a
 * `Stream<T>` handle whose async iterator yields `Chunk<T>` — an *array*
 * of elements for a non-`u8` element type — so a batched read is flattened
 * here. A web `ReadableStream` is also tolerated (websocket.js:644).
 */
async function* streamItems(
  stream: Stream<LiftedStreamMessage> | ReadableStream<unknown> | AsyncIterable<unknown>,
): AsyncGenerator<LiftedStreamMessage> {
  if (typeof ReadableStream !== "undefined" && stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value as LiftedStreamMessage;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const value of stream as AsyncIterable<unknown>) {
    // A batched read yields an array of elements.
    if (Array.isArray(value)) {
      yield* value as LiftedStreamMessage[];
    } else {
      yield value as LiftedStreamMessage;
    }
  }
}

/**
 * Coerce one chunk of a WIT byte stream (a number, an array of numbers, or
 * a typed array, depending on how the runtime batched the read) to a
 * `Uint8Array`. websocket.js:673.
 */
function toByteChunk(value: unknown): Uint8Array {
  if (typeof value === "number") return Uint8Array.of(value);
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(value as ArrayLike<number>);
}

/** A single-chunk byte `ReadableStream` over `bytes`. websocket.js:680. */
function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Collect a WIT byte stream into one `Uint8Array`, storing at most `limit`
 * bytes; bytes past the limit are consumed and counted in `excess`, never
 * buffered. websocket.js:694.
 */
async function collectByteStream(
  stream: Stream<number> | ReadableStream<unknown> | AsyncIterable<unknown>,
  limit: number,
): Promise<{ bytes: Uint8Array; excess: number }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let excess = 0;
  const push = (value: unknown) => {
    if (value === undefined || value === null) return;
    let chunk = toByteChunk(value);
    if (!chunk.length) return;
    const room = limit - total;
    if (chunk.length > room) {
      excess += chunk.length - Math.max(room, 0);
      if (room <= 0) return;
      chunk = chunk.subarray(0, room);
    }
    chunks.push(chunk);
    total += chunk.length;
  };
  if (typeof ReadableStream !== "undefined" && stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        push(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (stream instanceof Stream) {
    // The conventions' `Stream<u8>`: `read(max)` yields a `Uint8Array`, and
    // an EMPTY chunk means end-of-stream (contracts/embedder-api.md
    // §"Streams and futures"). Read in batches rather than per element.
    for (;;) {
      const chunk = await stream.read(READ_BATCH);
      if ((chunk as Uint8Array).length === 0) break;
      push(chunk);
    }
  } else {
    for await (const value of stream as AsyncIterable<unknown>) {
      push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: out, excess };
}

// ----- wiring --------------------------------------------------------------

/** The exact WIT interface id the suite imports (`requiredImports` confirms it). */
export const CONNECTIONS_INTERFACE = "polymorph:websocket/connections@0.1.0";

/**
 * The interface-shaped aggregate export (contracts/embedder-api.md
 * §"Module wiring and instantiation": "a module's named export, camelCase
 * of the interface short-name, provides that interface" — so
 * `export const connections = { Websocket }` survives the port unchanged).
 */
export const connections = { Websocket };

/**
 * The imports-record fragment for `instantiate`:
 * `{ "polymorph:websocket/connections@0.1.0": { Websocket } }`.
 *
 * Registered at the interface's **exact version**, not its `@0.1` track
 * key: the package is at `0.1.0` and only one version exists, so an exact
 * key is the narrowest correct registration (the resolver derives the
 * track alternate automatically — contracts/embedder-api.md
 * §"Version canonicalization", "Registration forms").
 */
export function websocketImports(
  options?: WebsocketOptions,
): Record<string, unknown> {
  if (options) configure(options);
  return { [CONNECTIONS_INTERFACE]: connections };
}
