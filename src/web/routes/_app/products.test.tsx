import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { renderApp, signedInAs } from "@/test/app";
import { product } from "@/test/fixtures";
import { server } from "@/test/server";

describe("products list", () => {
  test("/products lists the products the API answers, with Products current", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/products", () =>
        HttpResponse.json({ items: [product({ openIssues: 31 })] }),
      ),
    );
    renderApp("/products");
    expect(await screen.findAllByText("31")).not.toHaveLength(0);
    const nav = screen.getAllByRole("navigation")[0];
    if (!nav) throw new Error("no navigation");
    expect(within(nav).getByRole("link", { name: "Products" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
