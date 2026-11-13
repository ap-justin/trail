import { screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { PersonView } from "@/lib/api-types";
import { keys } from "@/lib/queries";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  commentEntry,
  issue,
  kai,
  maya,
  people,
  photoUrlFor,
  statusEntry,
} from "@/test/fixtures";
import { server } from "@/test/server";

const kaiPhoto = photoUrlFor("a-kai", "9c");
const mayaPhoto = photoUrlFor("a-maya", "5e");
const issueTitle = "Team access: invite people by GitHub username";

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

const rowFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);

const imgsOf = (url: string) =>
  document.querySelectorAll<HTMLImageElement>(`img[src="${url}"]`);

const liveStreams = () =>
  FakeEventSource.opened.filter((s) => s.readyState !== FakeEventSource.CLOSED);

type Cache = ReturnType<typeof renderApp>["queryClient"];

/**
 * Resolves once no read is in flight. A refetch an event wrongly started is in flight the
 * moment the event returns, so a count read after this includes it; one read earlier
 * passes whatever the code does.
 */
const readsSettled = (queryClient: Cache) =>
  waitFor(() => expect(queryClient.isFetching()).toBe(0));

/**
 * The shell's first open re-reads `/me`, and the answer overwrites any photo patched in
 * before it lands: wait it out before sending an actor event.
 */
async function openAndSettleSession(
  stream: FakeEventSource,
  queryClient: Cache,
) {
  stream.open();
  await waitFor(() =>
    expect(queryClient.isFetching({ queryKey: keys.me })).toBe(0),
  );
}

/** Answers the issue page's read, counting each one. */
function serveIssue() {
  const reads = { count: 0 };
  server.use(
    http.get("/api/web/issues/TRL-14", () => {
      reads.count += 1;
      return HttpResponse.json(issue());
    }),
  );
  return reads;
}

async function openIssue() {
  signedInAs("member");
  const reads = serveIssue();
  const app = renderApp("/issues/TRL-14");
  expect(await screen.findByText(issueTitle)).toBeInTheDocument();
  const stream = FakeEventSource.current;
  stream.open();
  return { ...app, reads, stream };
}

describe("an actor event on the feed", () => {
  async function openFeed() {
    signedInAs("member");
    const asked = serveFeed([
      commentEntry("e1", minutesAgo(1)),
      commentEntry("e2", minutesAgo(5), { actor: maya }),
      statusEntry("e3", minutesAgo(30)),
    ]);
    const { queryClient } = renderApp("/");
    await waitFor(() => expect(rowFor("e3")).not.toBeNull());
    const stream = FakeEventSource.current;
    stream.open();
    return { asked, stream, queryClient };
  }

  const order = () =>
    [...document.querySelectorAll("[data-entry-id]")].map((row) =>
      row.getAttribute("data-entry-id"),
    );

  test("swaps the actor's avatar in every row in place, with no read and no new row", async () => {
    const { asked, stream, queryClient } = await openFeed();
    stream.actor({ actorId: kai.id, photoUrl: kaiPhoto });
    expect(rowFor("e1")?.querySelector("img")).toHaveAttribute("src", kaiPhoto);
    expect(rowFor("e3")?.querySelector("img")).toHaveAttribute("src", kaiPhoto);
    expect(rowFor("e2")?.querySelector("img")).toBeNull();
    expect(order()).toEqual(["e1", "e2", "e3"]);
    expect(document.querySelector(".row-fresh")).toBeNull();
    await readsSettled(queryClient);
    expect(asked).toHaveLength(1);
  });

  test("a null photo puts the initials back", async () => {
    const { stream } = await openFeed();
    stream.actor({ actorId: kai.id, photoUrl: kaiPhoto });
    stream.actor({ actorId: kai.id, photoUrl: null });
    const avatar = rowFor("e1")?.querySelector('[data-actor-kind="bot"]');
    expect(avatar?.querySelector("img")).toBeNull();
    expect(avatar).toHaveTextContent("K");
  });

  test("rows the stream delivered take the new photo too", async () => {
    const { stream } = await openFeed();
    stream.send(commentEntry("e9", minutesAgo(0)), 9);
    stream.actor({ actorId: kai.id, photoUrl: kaiPhoto });
    expect(rowFor("e9")?.querySelector("img")).toHaveAttribute("src", kaiPhoto);
  });

  test("the viewer's own photo changes in the shell", async () => {
    const { stream } = await openFeed();
    const account = screen.getByRole("button", { name: "Account: Maya Chen" });
    expect(account.querySelector("img")).toBeNull();
    stream.actor({ actorId: maya.id, photoUrl: mayaPhoto });
    // the shell reads /me from the query cache, which tells its readers on its next tick
    await waitFor(() =>
      expect(account.querySelector("img")).toHaveAttribute("src", mayaPhoto),
    );
    expect(rowFor("e2")?.querySelector("img")).toHaveAttribute(
      "src",
      mayaPhoto,
    );
    expect(rowFor("e1")?.querySelector("img")).toBeNull();
  });
});

describe("an actor event off the feed", () => {
  test("swaps the avatar on an issue page without reading it again", async () => {
    const { reads, stream, queryClient } = await openIssue();
    expect(imgsOf(kaiPhoto)).toHaveLength(0);
    stream.actor({ actorId: kai.id, photoUrl: kaiPhoto });
    // the assignee and each timeline row Kai wrote
    await waitFor(() => expect(imgsOf(kaiPhoto).length).toBeGreaterThan(1));
    stream.actor({ actorId: kai.id, photoUrl: null });
    await waitFor(() => expect(imgsOf(kaiPhoto)).toHaveLength(0));
    await readsSettled(queryClient);
    expect(reads.count).toBe(1);
  });

  test("swaps the viewer's photo on the account page and in the account menu", async () => {
    signedInAs("member");
    const { queryClient } = renderApp("/account");
    expect(await screen.findByRole("heading", { name: "Theme" })).toBeVisible();
    await openAndSettleSession(FakeEventSource.current, queryClient);
    FakeEventSource.current.actor({ actorId: maya.id, photoUrl: mayaPhoto });
    // the account panel's avatar and the sidebar menu's
    await waitFor(() => expect(imgsOf(mayaPhoto)).toHaveLength(2));
  });

  test("reads the people list again, whose rows carry no actor id", async () => {
    signedInAs("owner");
    let list: PersonView[] = people;
    let reads = 0;
    server.use(
      http.get("/api/web/people", () => {
        reads += 1;
        return HttpResponse.json({ items: list });
      }),
    );
    const { queryClient } = renderApp("/people");
    expect(await screen.findByText("@mayachen")).toBeInTheDocument();
    await openAndSettleSession(FakeEventSource.current, queryClient);
    list = people.map((p) =>
      p.username === "mayachen" ? { ...p, photoUrl: mayaPhoto } : p,
    );
    FakeEventSource.current.actor({ actorId: maya.id, photoUrl: mayaPhoto });
    // the people row, beside the account menu that updated in place
    await waitFor(() => expect(imgsOf(mayaPhoto)).toHaveLength(2));
    expect(reads).toBe(2);
  });
});

describe("the shell's stream", () => {
  test("opens off the feed, closes while the feed holds its own, and opens again after", async () => {
    const { router, reads, queryClient } = await openIssue();
    const shell = FakeEventSource.current;
    expect(shell.url).toBe("/api/web/events?only=actors");
    expect(liveStreams()).toEqual([shell]);

    serveFeed([statusEntry("e3", minutesAgo(30))]);
    await router.navigate({ to: "/" });
    await waitFor(() => expect(rowFor("e3")).not.toBeNull());
    expect(shell.readyState).toBe(FakeEventSource.CLOSED);
    const [feed, ...others] = liveStreams();
    expect(others).toEqual([]);
    // the feed's stream carries the photos the shell's did
    feed?.open();
    feed?.actor({ actorId: maya.id, photoUrl: mayaPhoto });
    const account = screen.getByRole("button", { name: "Account: Maya Chen" });
    await waitFor(() =>
      expect(account.querySelector("img")).toHaveAttribute("src", mayaPhoto),
    );

    await router.navigate({ to: "/issues/$key", params: { key: "TRL-14" } });
    expect(await screen.findByText(issueTitle)).toBeInTheDocument();
    expect(feed?.readyState).toBe(FakeEventSource.CLOSED);
    const [reopened, ...more] = liveStreams();
    expect(more).toEqual([]);
    expect(reopened).not.toBe(shell);
    // nothing was missed while the feed's stream was open, so its first open reads nothing
    const before = reads.count;
    reopened?.open();
    reopened?.actor({ actorId: kai.id, photoUrl: kaiPhoto });
    await waitFor(() => expect(imgsOf(kaiPhoto).length).toBeGreaterThan(0));
    await readsSettled(queryClient);
    expect(reads.count).toBe(before);
  });

  test("a page opened on the feed holds one stream, not the shell's beside it", async () => {
    signedInAs("member");
    serveFeed([statusEntry("e3", minutesAgo(30))]);
    renderApp("/");
    await waitFor(() => expect(rowFor("e3")).not.toBeNull());
    expect(liveStreams()).toHaveLength(1);
  });

  test("an open after a gap reads every page again, once", async () => {
    const { reads, stream } = await openIssue();
    expect(reads.count).toBe(1);
    stream.fail();
    stream.open();
    // a photo change in the gap is never replayed; only reading again brings it
    await waitFor(() => expect(reads.count).toBe(2));
    // a later open reads again, but this one read only once
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads.count).toBe(2);
  });
});
