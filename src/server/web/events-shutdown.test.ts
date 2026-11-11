import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, expect, test, vi } from "vitest";
import { onShutdownSignal } from "../shutdown.js";
import { readEventStream, setupTestApp } from "../test-app.js";

const { app, signIn, owner, endStreams } = setupTestApp();

test("a shutdown ends open event streams, so the drain finishes without waiting for its deadline", async () => {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s as Server));
  });
  afterAll(() => server.closeAllConnections());
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/api/web/events`, {
    headers: { cookie: await signIn(owner) },
  });
  const stream = readEventStream(res);
  expect(await stream.next()).toEqual({ comment: "connected" });

  const proc = Object.assign(new EventEmitter(), { pid: 4242, kill: vi.fn() });
  const onClosed = vi.fn();
  onShutdownSignal({
    server,
    onDraining: endStreams,
    onClosed,
    deadlineMs: 60_000,
    proc,
  });
  proc.emit("SIGTERM");

  expect(await stream.next()).toBeNull();
  await vi.waitFor(
    () => expect(proc.kill).toHaveBeenCalledWith(4242, "SIGTERM"),
    {
      timeout: 2000,
    },
  );
  expect(onClosed).toHaveBeenCalledOnce();
});
