import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import { browser } from "@/lib/browser";
import { renderApp, signedInAs } from "@/test/app";
import { server } from "@/test/server";

afterEach(() => {
  vi.restoreAllMocks();
});

const page =
  "/sign-in/confirm?token=tok-1&callbackURL=%2Fprojects%2FTRL&email=mallory%40example.com";

function serveConfirm(answer: () => Response) {
  const sent: unknown[] = [];
  server.use(
    http.post("/api/auth/magic-link/confirm", async ({ request }) => {
      sent.push(await request.json());
      return answer();
    }),
  );
  return sent;
}

describe("/sign-in/confirm", () => {
  test("opening it spends nothing: it asks before posting the token", async () => {
    // any request would fail the test as unanswered (test/setup.ts)
    renderApp(page);
    expect(
      await screen.findByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent(
      "Continue to sign in with the link from your email.",
    );
    // an address in the URL is never shown: it isn't the link owner's to claim
    expect(screen.queryByText(/mallory/)).not.toBeInTheDocument();
  });

  test("Sign in posts the token and return path, then loads the page it answers with", async () => {
    const sent = serveConfirm(() =>
      HttpResponse.json({ redirectTo: "/projects/TRL" }),
    );
    const leave = vi.spyOn(browser, "leaveFor").mockImplementation(() => {});
    renderApp(page);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );
    await waitFor(() => expect(leave).toHaveBeenCalledWith("/projects/TRL"));
    expect(sent).toEqual([{ token: "tok-1", callbackURL: "/projects/TRL" }]);
    // still held: the browser is on its way
    expect(screen.getByRole("button", { name: "Signing in…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  test("a second press while the first is in flight sends nothing more", async () => {
    let release = () => {};
    const sent = serveConfirm(() => HttpResponse.json({ redirectTo: "/" }));
    server.use(
      http.post("/api/auth/magic-link/confirm", async ({ request }) => {
        sent.push(await request.json());
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ redirectTo: "/" });
      }),
    );
    vi.spyOn(browser, "leaveFor").mockImplementation(() => {});
    renderApp(page);
    const button = await screen.findByRole("button", { name: "Sign in" });
    await userEvent.click(button);
    await userEvent.click(
      await screen.findByRole("button", { name: "Signing in…" }),
    );
    release();
    await waitFor(() => expect(browser.leaveFor).toHaveBeenCalled());
    expect(sent).toHaveLength(1);
  });

  test("400 INVALID_TOKEN goes to sign-in with the link-didn't-work alert", async () => {
    signedInAs("anonymous");
    serveConfirm(() =>
      HttpResponse.json(
        { error: { code: "INVALID_TOKEN", message: "used or expired" } },
        { status: 400 },
      ),
    );
    const { router } = renderApp(page);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That link didn't work",
    );
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toEqual({ error: "INVALID_TOKEN" });
  });

  test.each([403, 500])(
    "%i shows the generic failure on the card and lets the viewer try again",
    async (status) => {
      serveConfirm(() =>
        HttpResponse.json(
          { error: { code: "INVALID_ORIGIN", message: "raw server text" } },
          { status },
        ),
      );
      renderApp(page);
      await userEvent.click(
        await screen.findByRole("button", { name: "Sign in" }),
      );
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Something went wrong on our side. Try again.",
      );
      expect(screen.queryByText("raw server text")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Sign in" }),
      ).not.toHaveAttribute("aria-disabled");
    },
  );

  test("without a token it goes straight to sign-in with the link-didn't-work alert", async () => {
    signedInAs("anonymous");
    const { router } = renderApp("/sign-in/confirm?callbackURL=%2F");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That link didn't work",
    );
    expect(router.state.location.pathname).toBe("/sign-in");
  });
});
