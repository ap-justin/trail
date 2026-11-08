import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { onShutdownSignal } from "./shutdown.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections();
});

/** A server whose one route answers with a stream that never ends, like an SSE feed. */
async function holdingServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    request({ port }, (res) => {
      res.once("data", () => resolve());
      res.on("error", () => {});
    })
      .on("error", () => {})
      .end();
  });
  return server;
}

function fakeProcess() {
  const kill = vi.fn();
  return Object.assign(new EventEmitter(), { pid: 4242, kill });
}

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s drains the server, runs onClosed, then dies by that signal",
  async (signal) => {
    const server = await holdingServer();
    const proc = fakeProcess();
    const onClosed = vi.fn();
    onShutdownSignal({ server, onClosed, deadlineMs: 50, proc });

    proc.emit(signal);
    // the open stream holds close() until the deadline cuts it
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalled(), {
      timeout: 1000,
    });

    expect(server.listening).toBe(false);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith(4242, signal);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  },
);

test("a second signal mid-drain dies at once without draining again", async () => {
  const server = await holdingServer();
  const proc = fakeProcess();
  const onClosed = vi.fn();
  const close = vi.spyOn(server, "close");
  onShutdownSignal({ server, onClosed, deadlineMs: 10_000, proc });

  proc.emit("SIGINT");
  proc.emit("SIGTERM");

  expect(close).toHaveBeenCalledOnce();
  expect(onClosed).not.toHaveBeenCalled();
  expect(proc.kill).toHaveBeenCalledExactlyOnceWith(4242, "SIGTERM");
});
