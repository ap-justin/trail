import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  commentEntry,
  issue,
  issueList,
  issueRow,
  kai,
  maya,
  project,
  statusUpdate,
  tara,
} from "@/test/fixtures";
import { server } from "@/test/server";

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

const rowFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);

const pills = (title: string) =>
  document.querySelectorAll(`[title="${title}"]`);

/** An `actor` event as the server sends it: both current values, no photo here. */
const titled = (actorId: string, title: string | null) => ({
  actorId,
  photoUrl: null,
  title,
});

describe("a bot's title changing live", () => {
  test("on the feed: the pill appears, changes and goes, in place, with no read", async () => {
    signedInAs("member");
    const asked = serveFeed([
      commentEntry("e1", minutesAgo(1)),
      commentEntry("e2", minutesAgo(5), { actor: maya }),
    ]);
    renderApp("/");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    const stream = FakeEventSource.current;
    stream.open();
    const row = () => within(rowFor("e1") as HTMLElement);

    stream.actor(titled(kai.id, "Platform Engineer"));
    expect(row().getByTitle("Platform Engineer")).toHaveTextContent(
      "Platform Engineer",
    );
    stream.actor(titled(kai.id, "Release manager"));
    expect(row().getByTitle("Release manager")).toBeInTheDocument();
    expect(pills("Platform Engineer")).toHaveLength(0);
    stream.actor(titled(kai.id, null));
    expect(row().queryByTitle("Release manager")).toBeNull();
    expect(rowFor("e2")?.querySelector("[title]:not(time)")).toBeNull();
    expect(asked).toHaveLength(1);
  });

  test("in the bot filter menu", async () => {
    const user = userEvent.setup();
    signedInAs("member");
    serveFeed([commentEntry("e1", minutesAgo(1))]);
    renderApp("/");
    await waitFor(() => expect(rowFor("e1")).not.toBeNull());
    const stream = FakeEventSource.current;
    stream.open();
    stream.actor(titled(kai.id, "Platform Engineer"));
    await user.click(screen.getByRole("combobox", { name: "Filter by bot" }));
    const option = await screen.findByRole("option", { name: /Kai/ });
    await waitFor(() =>
      expect(within(option).getByTitle("Platform Engineer")).toBeVisible(),
    );
  });

  test("on an issue page: assignee and the lines Kai wrote, without reading it again", async () => {
    signedInAs("member");
    let reads = 0;
    server.use(
      http.get("/api/web/issues/TRL-14", () => {
        reads += 1;
        return HttpResponse.json(issue());
      }),
    );
    renderApp("/issues/TRL-14");
    expect(
      await screen.findByText("Team access: invite people by GitHub username"),
    ).toBeInTheDocument();
    const stream = FakeEventSource.current;
    stream.open();
    stream.actor(titled(kai.id, "Platform Engineer"));
    // the assignee and both timeline lines Kai wrote
    await waitFor(() => expect(pills("Platform Engineer")).toHaveLength(3));
    stream.actor(titled(kai.id, null));
    await waitFor(() => expect(pills("Platform Engineer")).toHaveLength(0));
    expect(reads).toBe(1);
  });

  test("on a project page: the status update's author, not the issue list's assignee", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/projects/TRL", () => HttpResponse.json(project())),
      http.get("/api/web/projects/TRL/issues", () =>
        HttpResponse.json(issueList([issueRow({ assignee: tara })])),
      ),
      http.get("/api/web/projects/TRL/status-updates", () =>
        HttpResponse.json({
          items: [statusUpdate({ author: tara })],
          nextCursor: null,
        }),
      ),
    );
    renderApp("/projects/TRL");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    await screen.findByText(statusUpdate().body);
    const stream = FakeEventSource.current;
    stream.open();
    stream.actor(titled(tara.id, "Release manager"));
    await waitFor(() => expect(pills("Release manager")).toHaveLength(1));
    expect(
      within(screen.getByRole("table")).queryByTitle("Release manager"),
    ).toBeNull();
  });
});
