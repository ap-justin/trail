import { expect, test, vi } from "vitest";
import { readEventStream, setupTestApp } from "../test-app.js";

const { app, auth, signIn, owner, endStreams } = setupTestApp();

test("ending the streams settles only once a stream mid-check has stopped, so nothing queries after the database closes", async () => {
  const cookie = await signIn(owner);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const res = await app.request("/api/web/events", { headers: { cookie } });
  const stream = readEventStream(res);
  expect(await stream.next()).toEqual({ comment: "connected" });

  const viewer = await auth.resolveViewer(new Headers({ cookie }));
  let letThrough = () => {};
  const check = vi.spyOn(auth, "resolveViewer").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        letThrough = () => resolve(viewer);
      }),
  );
  await vi.advanceTimersByTimeAsync(15_000);
  expect(check).toHaveBeenCalledOnce();
  vi.useRealTimers();

  let settled = false;
  const ended = Promise.resolve(endStreams()).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);

  letThrough();
  await ended;
  expect(await stream.next()).toBeNull();
});
