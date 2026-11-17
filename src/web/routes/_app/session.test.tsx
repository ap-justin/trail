import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { MeView } from "@/lib/api-types";
import { keys } from "@/lib/queries";
import {
  meView,
  renderApp,
  serveFeed,
  serveInProgress,
  signedInAs,
} from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import { commentEntry } from "@/test/fixtures";
import { server } from "@/test/server";

async function onFeed() {
  signedInAs("member");
  serveFeed();
  const app = renderApp("/");
  expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  return app;
}

/** The feed a member with no project is served: nothing, nothing to filter by, no bot at work. */
function serveNoProjectsFeed() {
  serveInProgress();
  server.use(
    http.get("/api/web/feed", () =>
      HttpResponse.json({
        items: [],
        nextCursor: null,
        filters: { actors: [], products: [], projects: [] },
      }),
    ),
  );
}

describe("session", () => {
  test("a member with no product is told so, not that nothing happened", async () => {
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({ ...meView("member"), products: [] }),
      ),
    );
    serveNoProjectsFeed();
    renderApp("/");
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ask the person who runs this trail to give you access to a product.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /^Filter by/ }),
    ).not.toBeInTheDocument();
  });

  test("a member with no product has no Live indicator, though the stream is open", async () => {
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({ ...meView("member"), products: [] }),
      ),
    );
    serveNoProjectsFeed();
    renderApp("/");
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.opened).not.toHaveLength(0));
    FakeEventSource.current.open();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  test("a member added to a product while the Feed is open sees its history and filters on the next focus", async () => {
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({ ...meView("member"), products: [] }),
      ),
    );
    serveNoProjectsFeed();
    renderApp("/");
    expect(await screen.findByText("No products yet")).toBeInTheDocument();

    // the owner adds them: /me now lists the project, and /feed holds its history
    signedInAs("member");
    serveFeed([commentEntry("e1", new Date().toISOString())]);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull(),
    );
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by product" }),
    );
    expect(
      await screen.findByRole("option", { name: "TRL trail" }),
    ).toBeInTheDocument();
  });

  test("a member with no product sees Live once the stream brings rows", async () => {
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({ ...meView("member"), products: [] }),
      ),
    );
    serveNoProjectsFeed();
    renderApp("/");
    expect(await screen.findByText("No products yet")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.opened).not.toHaveLength(0));
    FakeEventSource.current.open();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();

    // added to a project in another tab: the stream checks access per event
    FakeEventSource.current.send(commentEntry("e1", new Date().toISOString()));
    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull(),
    );
    expect((await screen.findAllByText("Live")).length).toBeGreaterThan(0);
  });

  test("a member with products and an empty feed is told nothing happened yet, with the filters to hand", async () => {
    await onFeed();
    expect(screen.queryByText("No products yet")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("combobox", { name: /^Filter by/ }),
    ).toHaveLength(4);
  });

  test("a member with products sees Live once the stream opens", async () => {
    await onFeed();
    await waitFor(() => expect(FakeEventSource.opened).not.toHaveLength(0));
    FakeEventSource.current.open();
    expect((await screen.findAllByText("Live")).length).toBeGreaterThan(0);
  });

  test("an owner with no products is told it is quiet, not that they lack access", async () => {
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({ ...meView("owner"), products: [] }),
      ),
    );
    serveNoProjectsFeed();
    renderApp("/");
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByText("No products yet")).not.toBeInTheDocument();
  });

  test("Sign out calls the endpoint and lands on sign-in", async () => {
    const { router } = await onFeed();
    let signedOut = false;
    server.use(
      http.post("/api/auth/sign-out", () => {
        signedOut = true;
        signedInAs("anonymous");
        return HttpResponse.json({ success: true });
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Account: Maya Chen" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(signedOut).toBe(true);
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  test("a person signed in by email is let in, shown by their address, and signing out forgets it", async () => {
    const emailMember: MeView = {
      ...meView("member"),
      login: null,
      email: "dana@example.com",
      actor: {
        id: "a-dana",
        name: "dana.okafor",
        kind: "human",
        photoUrl: null,
        title: null,
      },
    };
    let meReads = 0;
    server.use(
      http.get("/api/web/me", () => {
        meReads++;
        return HttpResponse.json(emailMember);
      }),
      http.post("/api/auth/sign-out", () =>
        HttpResponse.json({ success: true }),
      ),
    );
    serveInProgress();
    serveFeed();
    const { router, queryClient } = renderApp("/");
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    const account = screen.getByRole("button", {
      name: "Account: dana.okafor",
    });
    expect(account).toHaveTextContent("dana@example.com");

    const readsBeforeSignOut = meReads;
    await userEvent.click(account);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    // what sign-out wrote to the cache, not a fresh /me: the address is gone with the session
    expect(meReads).toBe(readsBeforeSignOut);
    expect(queryClient.getQueryData<MeView>(keys.me)).toMatchObject({
      state: "anonymous",
      login: null,
      email: null,
      actor: null,
    });
  });

  test("Sign out from another page lands on plain sign-in, with no way back to it", async () => {
    signedInAs("member");
    const { router } = renderApp("/account");
    server.use(
      http.post("/api/auth/sign-out", () => {
        signedInAs("anonymous");
        return HttpResponse.json({ success: true });
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Account: Maya Chen" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(router.state.location.href).toBe("/sign-in");
  });

  test("a failed sign-out reads /me again and follows it", async () => {
    const { router } = await onFeed();
    server.use(
      http.post("/api/auth/sign-out", () => {
        // the session ended anyway; only the answer was lost
        signedInAs("anonymous");
        return HttpResponse.error();
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Account: Maya Chen" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sign out" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  test("a 401 mid-session returns to sign-in, which will bring the viewer back", async () => {
    const { router } = await onFeed();
    signedInAs("anonymous");
    server.use(
      http.get("/api/web/projects", () =>
        HttpResponse.json(
          { error: { code: "unauthorized", message: "Sign in first" } },
          { status: 401 },
        ),
      ),
    );
    // the cached /me still says member, so only the 401 can send the viewer back
    const [projectsLink] = screen.getAllByRole("link", { name: "Projects" });
    if (!projectsLink) throw new Error("no Projects link");
    await userEvent.click(projectsLink);
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: "/projects" });
  });

  test("a 403 mid-session means the owner removed this person, and /me says so", async () => {
    await onFeed();
    signedInAs("not_invited");
    server.use(
      http.get("/api/web/projects", () =>
        HttpResponse.json(
          { error: { code: "forbidden", message: "Not invited" } },
          { status: 403 },
        ),
      ),
    );
    const [projectsLink] = screen.getAllByRole("link", { name: "Projects" });
    if (!projectsLink) throw new Error("no Projects link");
    await userEvent.click(projectsLink);
    expect(
      await screen.findByRole("heading", { name: "You're not invited yet" }),
    ).toBeInTheDocument();
  });

  test("a /me refetch on focus that says not invited switches to that view", async () => {
    await onFeed();
    signedInAs("not_invited");
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(
      await screen.findByRole("heading", { name: "You're not invited yet" }),
    ).toBeInTheDocument();
  });
});
