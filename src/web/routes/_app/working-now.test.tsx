import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import { type HttpHandler, HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { WebActorView } from "@/lib/api-types";
import { renderApp, serveFeed, serveInProgress, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import { alpha, beta, issueRow, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";

const olive: WebActorView = {
  id: "a-olive",
  name: "Olive Owner",
  kind: "human",
  photoUrl: null,
  title: null,
};

const inProgress = (key: string, assignee: WebActorView) =>
  issueRow({ key, title: "Read the queue", status: "in_progress", assignee });

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

/**
 * The feed at `/` with `byProduct` as each product's in-progress items and `handlers` in
 * front, once its first row is on screen.
 */
async function openFeed(
  byProduct: Parameters<typeof serveInProgress>[0] = {},
  ...handlers: HttpHandler[]
) {
  signedInAs("member");
  serveInProgress(byProduct);
  server.use(...handlers);
  serveFeed([statusEntry("e1", minutesAgo(5))]);
  const app = renderApp("/");
  await waitFor(() =>
    expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull(),
  );
  return app;
}

/** Whether the strip is on screen once every read has answered. */
async function stripOnceSettled(queryClient: QueryClient) {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return strip();
}

const strip = () => screen.queryByRole("region", { name: "Working now" });

describe("working now", () => {
  test("a bot's in-progress item shows on the strip by its key", async () => {
    await openFeed({ TRL: [inProgress("TRL-5", alpha)] });
    const region = await screen.findByRole("region", { name: "Working now" });
    expect(within(region).getByText("TRL-5")).toBeInTheDocument();
  });

  test("nothing shows while no bot has an item in progress", async () => {
    const { queryClient } = await openFeed();
    expect(await stripOnceSettled(queryClient)).toBeNull();
  });

  test("an item in progress with a person is not bot work", async () => {
    const { queryClient } = await openFeed({
      TRL: [inProgress("TRL-6", olive)],
    });
    expect(await stripOnceSettled(queryClient)).toBeNull();
  });

  test("a product whose read fails leaves the others' bots and the feed in place", async () => {
    const { queryClient } = await openFeed(
      { DOC: [inProgress("DOC-2", beta)] },
      http.get("/api/web/products/TRL/items", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Broken" } },
          { status: 500 },
        ),
      ),
    );
    await stripOnceSettled(queryClient);
    const region = screen.getByRole("region", { name: "Working now" });
    expect(within(region).getByText("DOC-2")).toBeInTheDocument();
    expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull();
  });

  test("an item leaving in progress over the stream leaves the strip", async () => {
    // statusEntry moves TRL-12 from in progress to done
    await openFeed({ TRL: [inProgress("TRL-12", alpha)] });
    await screen.findByRole("region", { name: "Working now" });
    FakeEventSource.current.open();
    serveInProgress({ TRL: [] });
    act(() => FakeEventSource.current.send(statusEntry("e2", minutesAgo(0))));
    await waitFor(() => expect(strip()).toBeNull());
  });
});
