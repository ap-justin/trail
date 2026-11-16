import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { feedPage, renderApp, serveFeed, signedInAs } from "@/test/app";
import { commentEntry, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

const rowFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);

/** The bug showed the filters over "No activity yet", so rows and filters are asserted together. */
const expectFiltersShown = () =>
  waitFor(() =>
    expect(
      screen.getAllByRole("combobox", { name: /^Filter by (bot|project)$/ }),
    ).toHaveLength(2),
  );

test("coming back to a feed Query still holds shows its rows, even when the refetch brings the same data", async () => {
  signedInAs("member");
  server.use(
    http.get("/api/web/products", () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  serveFeed([
    commentEntry("e1", minutesAgo(1)),
    statusEntry("e2", minutesAgo(30)),
  ]);
  const { router } = renderApp("/");
  await waitFor(() => expect(rowFor("e2")).not.toBeNull());

  await router.navigate({ to: "/projects" });
  await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
  await router.navigate({ to: "/" });

  await waitFor(() => expect(rowFor("e1")).not.toBeNull());
  expect(rowFor("e2")).not.toBeNull();
  expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
  await expectFiltersShown();
});

test("coming back to a cached feed shows its rows while the refresh is still in flight", async () => {
  signedInAs("member");
  server.use(
    http.get("/api/web/products", () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
  const items = [
    commentEntry("e1", minutesAgo(1)),
    statusEntry("e2", minutesAgo(30)),
  ];
  serveFeed(items);
  const { router } = renderApp("/");
  await waitFor(() => expect(rowFor("e2")).not.toBeNull());

  await router.navigate({ to: "/projects" });
  await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));

  // the refresh never answers until released, so only the cache can supply rows
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshes = 0;
  server.use(
    http.get("/api/web/feed", async () => {
      refreshes++;
      await released;
      return HttpResponse.json(feedPage(items));
    }),
  );
  await router.navigate({ to: "/" });

  await waitFor(() => expect(rowFor("e1")).not.toBeNull());
  expect(rowFor("e2")).not.toBeNull();
  expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
  await expectFiltersShown();
  await waitFor(() => expect(refreshes).toBe(1));
  release();
});
