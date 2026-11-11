import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { createAppRouter } from "@/router";

test("the index route renders under a memory-history router", async () => {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/"] }),
  );
  render(<RouterProvider router={router} />);
  expect(
    await screen.findByRole("heading", { name: "trail" }),
  ).toBeInTheDocument();
});
