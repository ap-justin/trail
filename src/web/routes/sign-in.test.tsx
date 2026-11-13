import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import { browser } from "@/lib/browser";
import { meView, renderApp, serveFeed, signedInAs } from "@/test/app";
import { installFakeEventSource } from "@/test/event-source";
import { issue } from "@/test/fixtures";
import { server } from "@/test/server";

installFakeEventSource();
afterEach(() => {
  vi.restoreAllMocks();
});

describe("signed out", () => {
  test.each(["/", "/projects/TRL"])(
    "a visit to %s lands on sign-in",
    async (path) => {
      signedInAs("anonymous");
      const { router } = renderApp(path);
      expect(
        await screen.findByRole("heading", { name: "Sign in to trail" }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/sign-in"),
      );
    },
  );

  test("Continue with GitHub starts OAuth and follows the URL better-auth returns", async () => {
    signedInAs("anonymous");
    const sent: unknown[] = [];
    server.use(
      http.post("/api/auth/sign-in/social", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({
          url: "https://github.com/login/oauth",
          redirect: true,
        });
      }),
    );
    const leave = vi.spyOn(browser, "leaveFor").mockImplementation(() => {});
    renderApp("/sign-in");
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    );
    await waitFor(() =>
      expect(leave).toHaveBeenCalledWith("https://github.com/login/oauth"),
    );
    expect(sent).toEqual([
      { provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in" },
    ]);
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeDisabled();
  });
});

describe("the return address", () => {
  function serveSignIn() {
    const sent: unknown[] = [];
    server.use(
      http.post("/api/auth/sign-in/social", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ url: "https://github.com/login/oauth" });
      }),
    );
    vi.spyOn(browser, "leaveFor").mockImplementation(() => {});
    return sent;
  }

  async function continueWithGitHub() {
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    );
  }

  test("a signed-out visit to a deep link signs in back to it", async () => {
    signedInAs("anonymous");
    const sent = serveSignIn();
    const { router } = renderApp("/projects/TRL?status=done");
    await continueWithGitHub();
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ callbackURL: "/projects/TRL?status=done" });
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  test.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "https://evil.example/",
    "issues/TRL-14",
  ])(
    "%j is not a return address: sign-in returns to the feed",
    async (target) => {
      signedInAs("anonymous");
      const sent = serveSignIn();
      renderApp(`/sign-in?redirect=${encodeURIComponent(target)}`);
      await continueWithGitHub();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({ callbackURL: "/" });
    },
  );

  test("a /me refetch that lets the viewer in goes on to the return address", async () => {
    signedInAs("anonymous");
    const { router } = renderApp("/sign-in?redirect=%2Fissues%2FTRL-14");
    await screen.findByRole("heading", { name: "Sign in to trail" });
    signedInAs("member");
    server.use(
      http.get("/api/web/issues/TRL-14", () => HttpResponse.json(issue())),
    );
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/issues/TRL-14"),
    );
    // the issue read is still in flight at the pathname change: wait for it to land so it
    // cannot reach a later test's handlers
    await screen.findByRole("heading", { name: issue().title });
  });

  test("a member on sign-in goes on to the return address", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/issues/TRL-14", () => HttpResponse.json(issue())),
    );
    const { router } = renderApp("/sign-in?redirect=%2Fissues%2FTRL-14");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/issues/TRL-14"),
    );
    // the issue read is still in flight at the pathname change: wait for it to land so it
    // cannot reach a later test's handlers
    await screen.findByRole("heading", { name: issue().title });
  });
});

describe("a GitHub sign-in that failed", () => {
  test("canceled on GitHub says so on the sign-in line", async () => {
    signedInAs("anonymous");
    renderApp("/sign-in?error=access_denied");
    expect(
      await screen.findByText("Sign-in was canceled on GitHub."),
    ).toBeInTheDocument();
  });

  test("any other code shows the generic message, not the code", async () => {
    signedInAs("anonymous");
    renderApp("/sign-in?error=state_mismatch");
    expect(
      await screen.findByText("Something went wrong on our side. Try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/state_mismatch/)).not.toBeInTheDocument();
  });
});

describe("a sign-in that can't start", () => {
  const notConfigured = () =>
    HttpResponse.json(
      {
        error: {
          code: "github_not_configured",
          message: "GitHub sign-in is off: set GITHUB_CLIENT_ID",
        },
      },
      { status: 503 },
    );

  test("shows the server's message and lets the viewer try again", async () => {
    signedInAs("anonymous");
    server.use(http.post("/api/auth/sign-in/social", notConfigured));
    renderApp("/sign-in");
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    );
    expect(
      await screen.findByText("GitHub sign-in is off: set GITHUB_CLIENT_ID"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeEnabled();
  });

  test("from not invited, signs out and shows the message on sign-in", async () => {
    signedInAs("not_invited");
    server.use(
      http.post("/api/auth/sign-out", () => {
        signedInAs("anonymous");
        return HttpResponse.json({ success: true });
      }),
      http.post("/api/auth/sign-in/social", notConfigured),
    );
    renderApp("/sign-in");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Sign in with a different account",
      }),
    );
    expect(
      await screen.findByText("GitHub sign-in is off: set GITHUB_CLIENT_ID"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
  });
});

describe("signed in with an account not on the list", () => {
  test("shows the not-invited view with the login, and fetches no project data", async () => {
    signedInAs("not_invited");
    const { router } = renderApp("/");
    expect(
      await screen.findByRole("heading", { name: "You're not invited yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText("@stranger")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    // any project, feed or people request would fail the test as unanswered (test/setup.ts)
  });
});

describe("a member", () => {
  test("on /sign-in goes to the feed", async () => {
    signedInAs("member");
    serveFeed();
    const { router } = renderApp("/sign-in");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    // the feed read is still in flight at the pathname change: wait for it to land (the
    // empty feed replaces the skeleton) so it cannot reach a later test's handlers
    await screen.findByRole("heading", { name: "No activity yet" });
  });
});

describe("a sign-in link by email", () => {
  const linkFails = (status: number, code: string, headers?: HeadersInit) =>
    http.post("/api/auth/sign-in/magic-link", () =>
      HttpResponse.json(
        { error: { code, message: `trail says ${code}` } },
        { status, headers },
      ),
    );

  async function askForLink(address = "dana@example.com") {
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email" }),
      address,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );
  }

  test("posts the address with a return to the feed, then says to check email", async () => {
    signedInAs("anonymous");
    const sent: unknown[] = [];
    server.use(
      http.post("/api/auth/sign-in/magic-link", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json({ status: true });
      }),
    );
    renderApp("/sign-in");
    await askForLink();
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(sent).toEqual([{ email: "dana@example.com", callbackURL: "/" }]);

    await userEvent.click(
      screen.getByRole("button", { name: "Use a different address" }),
    );
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue("");
  });

  test.each([
    ["/projects/TRL?status=done", "/projects/TRL?status=done"],
    ["//evil.example", "/"],
    ["https://evil.example/", "/"],
  ])(
    "arriving with redirect %j asks for a link returning to %j",
    async (target, callbackURL) => {
      signedInAs("anonymous");
      const sent: unknown[] = [];
      server.use(
        http.post("/api/auth/sign-in/magic-link", async ({ request }) => {
          sent.push(await request.json());
          return HttpResponse.json({ status: true });
        }),
      );
      renderApp(`/sign-in?redirect=${encodeURIComponent(target)}`);
      await askForLink();
      await screen.findByText("Check your email");
      expect(sent).toEqual([{ email: "dana@example.com", callbackURL }]);
    },
  );

  test("400 invalid_email marks the field", async () => {
    signedInAs("anonymous");
    server.use(linkFails(400, "invalid_email"));
    renderApp("/sign-in");
    await askForLink();
    const field = screen.getByRole("textbox", { name: "Email" });
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveFocus();
    expect(
      screen.getByText("Enter an email address, like you@example.com."),
    ).toBeInTheDocument();
  });

  test("429 rate_limited says how many minutes to wait from Retry-After, and the address stays", async () => {
    signedInAs("anonymous");
    server.use(linkFails(429, "rate_limited", { "retry-after": "540" }));
    renderApp("/sign-in");
    await askForLink();
    expect(
      await screen.findByText("Too many requests, try again in 9 minutes."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveValue(
      "dana@example.com",
    );
    expect(screen.queryByText(/trail says/)).not.toBeInTheDocument();
  });

  test("503 sign_in_unavailable turns the form into the email-off line", async () => {
    signedInAs("anonymous");
    server.use(linkFails(503, "sign_in_unavailable"));
    renderApp("/sign-in");
    await askForLink();
    expect(
      await screen.findByText(
        "Email sign-in isn't available right now. Only invited accounts can sign in.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("with email off on the server, there is no way to ask for a link; GitHub stays", async () => {
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({ ...meView("anonymous"), emailSignIn: false }),
      ),
    );
    renderApp("/sign-in");
    expect(
      await screen.findByText(
        "Email sign-in isn't available right now. Only invited accounts can sign in.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeEnabled();
  });

  test("?error=INVALID_TOKEN shows that the link didn't work, not the generic failure", async () => {
    signedInAs("anonymous");
    renderApp("/sign-in?error=INVALID_TOKEN");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That link didn't work",
    );
    expect(
      screen.queryByText("Something went wrong on our side. Try again."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });
});

describe("signed in by email with an address not on the list", () => {
  const emailStranger = () =>
    http.get("/api/web/me", () =>
      HttpResponse.json({
        ...meView("not_invited"),
        login: null,
        email: "dana@example.com",
      }),
    );

  test("shows the address, and a different account signs out to sign-in without starting GitHub", async () => {
    server.use(
      emailStranger(),
      http.post("/api/auth/sign-out", () => {
        signedInAs("anonymous");
        return HttpResponse.json({ success: true });
      }),
    );
    // any POST to sign-in/social would fail the test as unanswered (test/setup.ts)
    renderApp("/sign-in");
    expect(
      await screen.findByRole("heading", { name: "You're not invited yet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent(
      "dana@example.com signed in by email, but that address isn't on the list.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in with a different account" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
  });
});
