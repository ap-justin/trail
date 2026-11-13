import { focusManager } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { MeView } from "@/lib/api-types";
import { keys } from "@/lib/queries";
import { meView, renderApp, serveFeed, signedInAs } from "@/test/app";
import { server } from "@/test/server";

async function onFeed() {
  signedInAs("member");
  serveFeed();
  const app = renderApp("/");
  expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  return app;
}

describe("session", () => {
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
