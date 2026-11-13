import { request } from "node:https";
import { isIP } from "node:net";
import { checkWebhookUrl, type Resolve, resolveHost } from "./address.js";
import { signedHeaders } from "./signing.js";

/** One POST, to a public address `checkWebhookUrl` already vetted; resolves with the status whatever it is. */
export type Transport = (call: {
  url: URL;
  address: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ status: number }>;

/** The whole attempt, connect to response head, not an idle gap: a receiver that drips bytes still runs out. */
export const SEND_TIMEOUT_MS = 10_000;
/** How long a connection may take to open before the other address family is tried. */
export const CONNECT_TIMEOUT_MS = 3_000;

// a connection that never opened: nothing was sent, so another address can be tried
const connectFailures = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
]);
const failedToConnect = (error: unknown) =>
  connectFailures.has((error as { code?: string } | null)?.code ?? "");

/**
 * https straight to the vetted address, so a DNS answer that changes after the
 * check can't redirect the connection; the host name still rides in SNI and
 * Host. Redirects are never followed: a 3xx is just a status. The response
 * body is dropped unread.
 */
export const httpsTransport: Transport = ({
  url,
  address,
  headers,
  body,
  signal,
}) =>
  new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const req = request(
      {
        host: address,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...headers,
          host: url.host,
          "content-length": String(Buffer.byteLength(body)),
          "user-agent": "trail-webhooks/1",
        },
        servername: isIP(hostname) === 0 ? hostname : undefined,
        signal,
      },
      (res) => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    // a host that drops packets would hold the attempt to its whole deadline
    req.on("socket", (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(
        () =>
          req.destroy(
            Object.assign(new Error("connect timed out"), {
              code: "ETIMEDOUT",
            }),
          ),
        CONNECT_TIMEOUT_MS,
      );
      timer.unref();
      socket.once("connect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    });
    req.end(body);
  });

export type SendDeps = {
  resolve: Resolve;
  transport: Transport;
  now: () => number;
  /** aborts when an attempt's time is up */
  deadline: () => AbortSignal;
};

export const defaultSendDeps: SendDeps = {
  resolve: resolveHost,
  transport: httpsTransport,
  now: Date.now,
  deadline: () => AbortSignal.timeout(SEND_TIMEOUT_MS),
};

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; retryable: boolean };

// a 401/403/404 is often a receiver mid-deploy or mid-rotation, so every 4xx
// retries; 410 Gone is the one 4xx that says stop
// a 3xx is retried too, never followed: the bot can fix the URL while the delivery waits
const retryableStatus = (status: number) => status >= 300 && status !== 410;

/** A short, safe description of a failure: a code or message, never a URL or a secret. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const text = typeof code === "string" ? code : error.message;
    return text.slice(0, 200);
  }
  return "request failed";
}

/** `resolve`, cut short when `signal` aborts: a DNS lookup takes no signal of its own. */
const resolveUntil =
  (resolve: Resolve, signal: AbortSignal): Resolve =>
  (host) =>
    new Promise((done, fail) => {
      signal.throwIfAborted();
      const onAbort = () => fail(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      resolve(host)
        .then(done, fail)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });

/**
 * Signs and sends one webhook, checking the URL's address first. Never throws:
 * a refused address and a network error are retryable failures, as are every
 * 3xx (never followed), every 4xx but 410 and every 5xx; only 410 is not.
 */
export async function sendWebhook(
  deps: SendDeps,
  call: { url: string; secret: string; deliveryId: string; body: string },
  signal?: AbortSignal,
): Promise<SendResult> {
  let deadline: AbortSignal | undefined;
  try {
    const { url, address, fallback } = await checkWebhookUrl(
      call.url,
      signal ? resolveUntil(deps.resolve, signal) : deps.resolve,
    );
    const headers = signedHeaders({
      secret: call.secret,
      deliveryId: call.deliveryId,
      body: call.body,
      now: deps.now(),
    });
    deadline = deps.deadline();
    const give = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const post = (to: string) =>
      deps.transport({
        url,
        address: to,
        headers,
        body: call.body,
        signal: give,
      });
    const { status } = await post(address).catch((error) => {
      // a host whose first address is unreachable (an IPv6 route that isn't there) may still answer on the other family
      if (fallback === undefined || !failedToConnect(error) || give.aborted) {
        throw error;
      }
      return post(fallback);
    });
    if (status >= 200 && status < 300) return { ok: true, status };
    return {
      ok: false,
      status,
      error:
        status >= 300 && status < 400
          ? `HTTP ${status}: trail does not follow redirects, so set the subscription to the final URL`
          : `HTTP ${status}`,
      retryable: retryableStatus(status),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error:
        deadline?.aborted && !signal?.aborted
          ? `no answer within ${SEND_TIMEOUT_MS / 1000}s`
          : describe(error),
      retryable: true,
    };
  }
}
