import { focusManager } from "@tanstack/react-query";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { installFakeEventSource } from "@/test/event-source";
import { server } from "@/test/server";

installFakeEventSource();

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
