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

export const SEND_TIMEOUT_MS = 10_000;

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
        timeout: SEND_TIMEOUT_MS,
        signal,
      },
      (res) => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`no answer within ${SEND_TIMEOUT_MS / 1000}s`)),
    );
    req.on("error", reject);
    req.end(body);
  });

export type SendDeps = {
  resolve: Resolve;
  transport: Transport;
  now: () => number;
};

export const defaultSendDeps: SendDeps = {
  resolve: resolveHost,
  transport: httpsTransport,
  now: Date.now,
};

export type SendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string; retryable: boolean };

// the statuses a receiver uses to say "try again"
const retryableStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

/** A short, safe description of a failure: a code or message, never a URL or a secret. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const text = typeof code === "string" ? code : error.message;
    return text.slice(0, 200);
  }
  return "request failed";
}

/**
 * Signs and sends one webhook, checking the URL's address first. Never throws:
 * a refused address and a network error are retryable failures, as are 408,
 * 429 and 5xx; any other non-2xx status is not.
 */
export async function sendWebhook(
  deps: SendDeps,
  call: { url: string; secret: string; deliveryId: string; body: string },
  signal?: AbortSignal,
): Promise<SendResult> {
  try {
    const { url, address } = await checkWebhookUrl(call.url, deps.resolve);
    const headers = signedHeaders({
      secret: call.secret,
      deliveryId: call.deliveryId,
      body: call.body,
      now: deps.now(),
    });
    const { status } = await deps.transport({
      url,
      address,
      headers,
      body: call.body,
      signal,
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
      error: describe(error),
      retryable: true,
    };
  }
}
