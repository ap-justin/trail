import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ProductsView, type ProductsViewProps } from "@/components/products";
import { product, statusUpdate } from "@/test/fixtures";

const now = new Date("2026-11-11T09:53:00.000Z");

function renderProducts(overrides: Partial<ProductsViewProps> = {}) {
  render(
    <ProductsView
      status="ready"
      products={[product()]}
      ownerName="Jordan Smith"
      isOwner={false}
      onRetry={vi.fn()}
      now={now}
      {...overrides}
    />,
  );
}

// the table (1440) and the cards (375) are both in the DOM; CSS shows one
const table = () => screen.getByRole("table");
const card = () => within(screen.getByRole("listitem"));
const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell");
const firstRow = () => {
  const row = within(table()).getAllByRole("row")[1];
  if (!row) throw new Error("no product row");
  return row;
};

describe("products", () => {
  test("the columns read Product, Health, Latest status update, Open issues, Open todos, Projects, Updated", () => {
    renderProducts();
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Product",
      "Health",
      "Latest status update",
      "Open issues",
      "Open todos",
      "Projects",
      "Updated",
    ]);
  });

  test("a product with a status update shows its health and the update's author", () => {
    renderProducts();
    expect(within(table()).getByText("On track")).toBeInTheDocument();
    expect(within(table()).getByText("Beta")).toBeInTheDocument();
    expect(
      within(table()).getByRole("img", { name: "Beta, bot" }),
    ).toBeInTheDocument();
    expect(within(table()).queryByText("Bot")).toBeNull();
    expect(within(table()).getByText("41m ago")).toBeInTheDocument();
  });

  test('"No status update yet" shows no health, even with a health on file; the Health column reads "None yet"', () => {
    renderProducts({
      products: [product({ latestStatusUpdate: null, health: "at_risk" })],
    });
    expect(screen.getAllByText("No status update yet")).toHaveLength(2);
    expect(within(table()).getByText("None yet")).toBeInTheDocument();
    for (const word of ["On track", "At risk", "Off track"]) {
      expect(screen.queryByText(word)).not.toBeInTheDocument();
    }
  });

  test("open issues, open todos and projects each get a column; the card says them in a line", () => {
    renderProducts({
      products: [product({ openIssues: 6, openTodos: 1, projectCount: 2 })],
    });
    const cells = cellsOf(firstRow());
    expect(cells[3]).toHaveTextContent(/^6$/);
    expect(cells[4]).toHaveTextContent(/^1$/);
    expect(cells[5]).toHaveTextContent(/^2$/);
    expect(
      card().getByText("6 issues · 1 todo open · 2 projects"),
    ).toBeInTheDocument();
  });

  test("the repo line shows owner/name and opens GitHub, only for a product with a repo", () => {
    renderProducts({
      products: [
        product({ repoUrl: "https://github.com/example/trail" }),
        product({ key: "DOC", name: "Docs site", repoUrl: null }),
      ],
    });
    const repoLinks = screen.getAllByRole("link", { name: /example\/trail/ });
    // one in the table, one on the card
    expect(repoLinks).toHaveLength(2);
    for (const link of repoLinks) {
      expect(link).toHaveAttribute("href", "https://github.com/example/trail");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).not.toHaveTextContent("github.com");
    }
    const docRow = table().querySelector('[data-product-key="DOC"]');
    if (!(docRow instanceof HTMLElement)) throw new Error("no DOC row");
    expect(within(docRow).getAllByRole("link")).toHaveLength(1);
  });

  test("a card reads name, the update, its author and age, then the counts", () => {
    renderProducts();
    const item = screen.getByRole("listitem");
    const order = [
      within(item).getByRole("link", { name: "TRL trail" }),
      within(item).getByText(/^SSE feed shipped/),
      within(item).getByText("Beta"),
      within(item).getByText("41m ago"),
      within(item).getByText("7 issues · 2 todos open · 0 projects"),
    ];
    for (const [before, after] of order
      .slice(0, -1)
      .map((el, i) => [el, order[i + 1]])) {
      if (!before || !after) throw new Error("missing card part");
      expect(
        before.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  test("each product links to its page", () => {
    renderProducts();
    for (const link of screen.getAllByRole("link", { name: "TRL trail" })) {
      expect(link).toHaveAttribute("href", "/products/TRL");
    }
  });

  test("a status update shows its words, not its Markdown, in the table and the card", () => {
    renderProducts({
      products: [
        product({
          latestStatusUpdate: statusUpdate({
            body: "**Shipped** the `invite` flow\n\n- next: SSE",
          }),
        }),
      ],
    });
    for (const scope of [within(table()), card()]) {
      const text = scope.getByText(/Shipped/).closest("p");
      expect(text).toHaveTextContent("Shipped the invite flow next: SSE");
      expect(text).not.toHaveTextContent("**");
      expect(text).not.toHaveTextContent("`");
    }
  });

  test("a person with no products is told to ask the owner by name", () => {
    renderProducts({ products: [] });
    expect(
      screen.getByRole("heading", { name: "No products yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask Jordan Smith to give you access to a product."),
    ).toBeInTheDocument();
  });

  test("a failed load says so and offers Try again", async () => {
    const onRetry = vi.fn();
    renderProducts({ status: "error", onRetry });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load products",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("while loading, one Loading status and no rows", () => {
    renderProducts({ status: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
