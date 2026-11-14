import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { commentEntry, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

const rowFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);

test("coming back to a feed Query still holds shows its rows, even when the refetch brings the same data", async () => {
  signedInAs("member");
  server.use(
    http.get("/api/web/projects", () =>
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
});
