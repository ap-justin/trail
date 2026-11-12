import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { installFakeEventSource } from "@/test/event-source";
import { server } from "@/test/server";

installFakeEventSource();

describe("trail unreachable on load", () => {
  test("shows the error state, and Try again loads the page once trail answers", async () => {
    server.use(http.get("/api/web/me", () => HttpResponse.error()));
    renderApp("/");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't reach trail");
    expect(alert).toHaveTextContent("Check your connection, then try again.");

    signedInAs("member");
    serveFeed();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
  });
});
