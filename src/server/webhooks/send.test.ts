import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer, globalAgent, type Server } from "node:https";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultSendDeps, httpsTransport, sendWebhook } from "./send.js";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./test-tls.js";

// The real transport against a TLS server on the loopback. The vetted address
// is 127.0.0.1 (the address check lives in address.ts, not here) while the
// URL names bot.example.com, which has no DNS: a connection can reach the
// server only by going to the address it was handed.
type Seen = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
  sni: string | false | null | undefined;
};
const seen: Seen[] = [];
let respond: (res: ServerResponse) => void = (res) => res.end();
let server: Server;
let port = 0;
let trusted: typeof globalAgent.options.ca;

beforeAll(async () => {
  // the transport takes no CA option, so the one self-signed certificate is trusted on the shared agent
  trusted = globalAgent.options.ca;
  globalAgent.options.ca = TEST_TLS_CERT;
  server = createServer(
    { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
          sni: (req.socket as TLSSocket).servername,
        });
        respond(res);
      });
    },
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  globalAgent.options.ca = trusted;
  server.closeAllConnections();
  server.close();
});

const call = (url: string, signal?: AbortSignal) =>
  httpsTransport({
    url: new URL(url),
    address: "127.0.0.1",
    headers: {
      "content-type": "application/json",
      "x-openbot-signature": "sig",
    },
    body: '{"n":"é"}',
    signal,
  });

describe("httpsTransport", () => {
  test("connects to the vetted address and names the host in SNI and Host", async () => {
    seen.length = 0;
    const { status } = await call(
      `https://bot.example.com:${port}/hooks/trail?x=1`,
    );
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    const [got] = seen;
    expect(got?.sni).toBe("bot.example.com");
    expect(got?.headers.host).toBe(`bot.example.com:${port}`);
    expect(got).toMatchObject({
      method: "POST",
      url: "/hooks/trail?x=1",
      body: '{"n":"é"}',
    });
    expect(got?.headers).toMatchObject({
      "content-type": "application/json",
      "x-openbot-signature": "sig",
      "user-agent": "trail-webhooks/1",
      // bytes, not characters
      "content-length": "10",
    });
  });

  test("the certificate is checked against the host name, not the address it connected to", async () => {
    seen.length = 0;
    await expect(
      call(`https://other.example.com:${port}/hook`),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(seen).toHaveLength(0);
  });

  test("a redirect is a status, never followed", async () => {
    seen.length = 0;
    respond = (res) => {
      res.statusCode = 302;
      res.setHeader("location", `https://bot.example.com:${port}/elsewhere`);
      res.end();
    };
    try {
      const { status } = await call(`https://bot.example.com:${port}/old`);
      expect(status).toBe(302);
      expect(seen.map((s) => s.url)).toEqual(["/old"]);
    } finally {
      respond = (res) => res.end();
    }
  });

  test("an aborted signal cuts a request the receiver never answers", async () => {
    seen.length = 0;
    const held: ServerResponse[] = [];
    respond = (res) => {
      held.push(res);
    };
    try {
      const abort = new AbortController();
      const sent = call(`https://bot.example.com:${port}/hang`, abort.signal);
      const settled = expect(sent).rejects.toMatchObject({
        name: "AbortError",
      });
      for (let i = 0; i < 500 && seen.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seen).toHaveLength(1);
      abort.abort();
      await settled;
    } finally {
      respond = (res) => res.end();
      for (const res of held) res.destroy();
    }
  });
});

describe("sendWebhook over the real transport", () => {
  // sendWebhook refuses a loopback address, so the vetted public address it
  // resolves is swapped for the loopback one just below the check
  const deps = (deadline: () => AbortSignal) => ({
    ...defaultSendDeps,
    resolve: async () => ["93.184.216.34"],
    transport: (c: Parameters<typeof httpsTransport>[0]) =>
      httpsTransport({ ...c, address: "127.0.0.1" }),
    deadline,
  });
  const webhook = (path: string) => ({
    url: `https://bot.example.com:${port}${path}`,
    secret: "whsec_send_0123456789abcdef",
    deliveryId: "d-1",
    body: "{}",
  });

  test("a redirect is never followed and is retried, telling the bot to set the final URL", async () => {
    seen.length = 0;
    respond = (res) => {
      res.statusCode = 301;
      res.setHeader("location", `https://bot.example.com:${port}/new`);
      res.end();
    };
    try {
      const result = await sendWebhook(
        { ...deps(() => AbortSignal.timeout(5_000)), now: () => 0 },
        webhook("/old"),
      );
      expect(result).toMatchObject({
        ok: false,
        status: 301,
        retryable: true,
      });
      expect(result.ok === false && result.error).toContain(
        "does not follow redirects",
      );
      expect(seen).toHaveLength(1);
    } finally {
      respond = (res) => res.end();
    }
  });

  test("the deadline cuts a receiver that never answers, and the failure is retryable", async () => {
    seen.length = 0;
    const held: ServerResponse[] = [];
    respond = (res) => {
      held.push(res);
    };
    try {
      const deadline = new AbortController();
      const sent = sendWebhook(
        deps(() => deadline.signal),
        webhook("/slow"),
      );
      for (let i = 0; i < 500 && seen.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seen).toHaveLength(1);
      deadline.abort();
      expect(await sent).toEqual({
        ok: false,
        status: null,
        error: "no answer within 10s",
        retryable: true,
      });
    } finally {
      respond = (res) => res.end();
      for (const res of held) res.destroy();
    }
  });
});

test("a shutdown cuts a lookup that hasn't answered, and nothing is sent", async () => {
  let sent = 0;
  const shutdown = new AbortController();
  const result = sendWebhook(
    {
      ...defaultSendDeps,
      resolve: () => new Promise(() => {}),
      transport: async () => {
        sent++;
        return { status: 200 };
      },
    },
    {
      url: "https://bot.example.com/hook",
      secret: "s",
      deliveryId: "d",
      body: "{}",
    },
    shutdown.signal,
  );
  shutdown.abort();
  expect(await result).toMatchObject({ ok: false, retryable: true });
  expect(sent).toBe(0);
});

describe("sendWebhook's status classes", () => {
  const send = (status: number) =>
    sendWebhook(
      {
        ...defaultSendDeps,
        resolve: async () => ["93.184.216.34"],
        transport: async () => ({ status }),
      },
      {
        url: "https://bot.example.com/hook",
        secret: "s",
        deliveryId: "d",
        body: "{}",
      },
    );

  test.each([200, 201, 204, 299])("%i is delivered", async (status) => {
    expect(await send(status)).toEqual({ ok: true, status });
  });

  // 408 and 429 are the receiver asking to be tried again; a 410 is it saying stop
  test.each([
    [400, true],
    [401, true],
    [404, true],
    [408, true],
    [429, true],
    [499, true],
    [410, false],
    [500, true],
    [503, true],
    [301, true],
    [302, true],
    [307, true],
    [399, true],
  ])("%i is retryable: %s", async (status, retryable) => {
    expect(await send(status)).toMatchObject({ ok: false, status, retryable });
  });
});

describe("sendWebhook's fallback to the other address family", () => {
  const V4 = "93.184.216.34";
  const V6 = "2606:2800:220:1:248:1893:25c8:1946";
  const tried: string[] = [];
  const send = (
    addresses: string[],
    transport: (address: string) => Promise<{ status: number }>,
  ) => {
    tried.length = 0;
    return sendWebhook(
      {
        ...defaultSendDeps,
        resolve: async () => addresses,
        transport: ({ address }) => {
          tried.push(address);
          return transport(address);
        },
      },
      {
        url: "https://bot.example.com/hook",
        secret: "s",
        deliveryId: "d",
        body: "{}",
      },
    );
  };
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });

  test("a refused connection to the first address is tried on the other family", async () => {
    const result = await send([V6, V4], async (address) => {
      if (address === V6) throw refused;
      return { status: 200 };
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(tried).toEqual([V6, V4]);
  });

  test.each(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT"])(
    "%s on the first address falls back too",
    async (code) => {
      const result = await send([V4, V6], async (address) => {
        if (address === V4) throw Object.assign(new Error(code), { code });
        return { status: 204 };
      });
      expect(result).toMatchObject({ ok: true });
      expect(tried).toEqual([V4, V6]);
    },
  );

  test("an answer from the first address is final, whatever its status", async () => {
    const result = await send([V6, V4], async () => ({ status: 503 }));
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(tried).toEqual([V6]);
  });

  test("a failure after the connection opened is not retried elsewhere", async () => {
    const result = await send([V6, V4], async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    expect(result).toMatchObject({ ok: false, error: "ECONNRESET" });
    expect(tried).toEqual([V6]);
  });

  test("with one family there is nothing to fall back to", async () => {
    const result = await send([V4, "93.184.216.35"], async () => {
      throw refused;
    });
    expect(result).toMatchObject({ ok: false, error: "ECONNREFUSED" });
    expect(tried).toEqual([V4]);
  });

  test("when both families refuse, the failure is the last one's and retryable", async () => {
    const result = await send([V6, V4], async () => {
      throw refused;
    });
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(tried).toEqual([V6, V4]);
  });

  test("an address of either family inside a private range refuses the whole host before any connection", async () => {
    for (const addresses of [
      [V4, "fd00:ec2::254"],
      [V6, "10.0.0.5"],
    ]) {
      const result = await send(addresses, async () => ({ status: 200 }));
      expect(result).toMatchObject({ ok: false, retryable: true });
      expect(tried).toEqual([]);
    }
  });

  test("over the real transport, a closed port on the first address falls back to the one that answers", async () => {
    seen.length = 0;
    // the vetted addresses are public, as the check demands; each is swapped for the loopback just below it,
    // the IPv4 one at a port nothing listens on and the IPv6 one at the server
    const closed = await new Promise<number>((done) => {
      const probe = createNetServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => done(free));
      });
    });
    const result = await sendWebhook(
      {
        ...defaultSendDeps,
        resolve: async () => [V4, V6],
        transport: (c) => {
          const url = new URL(c.url);
          url.port = String(c.address === V4 ? closed : port);
          return httpsTransport({ ...c, url, address: "127.0.0.1" });
        },
      },
      {
        url: `https://bot.example.com:${port}/fallback`,
        secret: "whsec_send_0123456789abcdef",
        deliveryId: "d-2",
        body: "{}",
      },
    );
    expect(result).toEqual({ ok: true, status: 200 });
    expect(seen.map((s) => s.url)).toEqual(["/fallback"]);
  });
});
