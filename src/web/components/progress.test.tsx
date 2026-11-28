import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { BurnUp } from "@/components/burn-up";
import { ByProduct, ProgressSummary } from "@/components/progress";
import type { ProjectProgress } from "@/lib/api-types";
import { docsSite, openBot, projectDetail, trail } from "@/test/fixtures";

// local-time, so "today" is Nov 28 in any zone the suite runs in
const now = new Date(2026, 10, 28, 12, 0, 0);

const base = projectDetail().progress;
function progress(overrides: Partial<ProjectProgress> = {}): ProjectProgress {
  return { ...base, ...overrides };
}

function renderSummary(overrides: Partial<ProjectProgress> = {}) {
  render(<ProgressSummary progress={progress(overrides)} now={now} />);
}

const cell = (label: string) => {
  const found = screen.getByText(label).parentElement;
  if (!found) throw new Error(`no ${label} cell`);
  return found;
};
const legend = () =>
  within(cell("Progress"))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("ProgressSummary · Progress", () => {
  test("the done percent from the server, done of scope, and a legend with counts", () => {
    renderSummary();
    const progressCell = cell("Progress");
    expect(progressCell).toHaveTextContent("58% 18 of 31 items done");
    expect(legend()).toEqual(["Done 18", "In progress 3", "Open 10"]);
  });

  test("the percent is the server's, not recomputed from the counts", () => {
    // 1 of 300 is 0.33%, which a recomputing component rounds to 0; the server shows 1
    renderSummary({
      itemsDone: 1,
      itemsInProgress: 0,
      itemsOpen: 299,
      itemsInScope: 300,
      donePercent: 1,
    });
    expect(cell("Progress")).toHaveTextContent("1% 1 of 300 items done");
  });

  test("the bar has a segment per non-zero status, sized by count", () => {
    renderSummary({ itemsDone: 0, itemsInProgress: 3, itemsOpen: 28 });
    const segments = cell("Progress").querySelectorAll("[data-segment]");
    expect(
      [...segments].map((s) => [
        s.getAttribute("data-segment"),
        (s as HTMLElement).style.flexGrow,
      ]),
    ).toEqual([
      ["in_progress", "3"],
      ["open", "28"],
    ]);
  });

  test("nothing done reads 0% and keeps Done in the legend", () => {
    renderSummary({
      itemsDone: 0,
      itemsInProgress: 0,
      itemsOpen: 31,
      donePercent: 0,
    });
    expect(cell("Progress")).toHaveTextContent("0% 0 of 31 items done");
    expect(legend()).toEqual(["Done 0", "Open 31"]);
  });

  test("everything done drops In progress and Open from the legend", () => {
    renderSummary({
      itemsDone: 31,
      itemsInProgress: 0,
      itemsOpen: 0,
      donePercent: 100,
    });
    expect(legend()).toEqual(["Done 31"]);
  });

  test.each([
    [4, 2, "4 in triage and 2 canceled aren't counted."],
    [1, 1, "1 in triage and 1 canceled aren't counted."],
    [3, 0, "3 in triage aren't counted."],
    [1, 0, "1 in triage isn't counted."],
    [0, 1, "1 canceled isn't counted."],
    [0, 2, "2 canceled aren't counted."],
  ])("%i in triage and %i canceled: %s", (itemsTriage, itemsCanceled, line) => {
    renderSummary({ itemsTriage, itemsCanceled });
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  test("no triage and nothing canceled draws no line", () => {
    renderSummary({ itemsTriage: 0, itemsCanceled: 0 });
    expect(screen.queryByText(/counted\.$/)).toBeNull();
  });
});

describe("ProgressSummary · hours", () => {
  test("hours left, a bar of hours done, done of estimated and the unestimated items", () => {
    renderSummary();
    const hours = cell("Estimated work hours left");
    expect(hours).toHaveTextContent("24.5 h");
    expect(hours).toHaveTextContent("40 of 64.5 estimated hours done (62%)");
    expect(hours).toHaveTextContent("2 unfinished items have no estimate");
    const fill = hours.querySelector<HTMLElement>("[data-hours-done]");
    // 40 of 64.5 h, a literal rather than the component's own ratio
    expect(Number.parseFloat(fill?.style.width ?? "")).toBeCloseTo(62.0155, 3);
  });

  test("the hours percent in the line is the server's, not recomputed from the hours", () => {
    // the server rounds a sliver up to 1; the ratio 1/300 would read 0%
    renderSummary({
      hoursEstimated: 300,
      hoursDone: 1,
      hoursLeft: 299,
      hoursDonePercent: 1,
    });
    const hours = cell("Estimated work hours left");
    expect(hours).toHaveTextContent("1 of 300 estimated hours done (1%)");
    const fill = hours.querySelector<HTMLElement>("[data-hours-done]");
    expect(Number.parseFloat(fill?.style.width ?? "")).toBeCloseTo(0.3333, 3);
  });

  test("one unestimated item is singular", () => {
    renderSummary({ unfinishedWithoutEstimate: 1 });
    expect(
      screen.getByText("1 unfinished item has no estimate"),
    ).toBeInTheDocument();
  });

  test("every unfinished item estimated drops the caveat", () => {
    renderSummary({ unfinishedWithoutEstimate: 0 });
    expect(screen.queryByText(/no estimate/)).toBeNull();
  });

  test("no estimates at all: None estimated, no bar", () => {
    renderSummary({
      hoursEstimated: 0,
      hoursDone: 0,
      hoursLeft: 0,
      hoursDonePercent: 0,
      unfinishedWithoutEstimate: 13,
    });
    const hours = cell("Estimated work hours left");
    expect(hours).toHaveTextContent(
      "None estimatedNone of the 13 unfinished items has an estimate.",
    );
    expect(hours.querySelector("[data-hours-done]")).toBeNull();
  });

  test("no estimates and one unfinished item", () => {
    renderSummary({
      itemsInProgress: 0,
      itemsOpen: 1,
      hoursEstimated: 0,
      hoursDone: 0,
      hoursLeft: 0,
      hoursDonePercent: 0,
      unfinishedWithoutEstimate: 1,
    });
    expect(
      screen.getByText("The unfinished item has no estimate."),
    ).toBeInTheDocument();
  });

  test("unfinished items all estimated at 0 h: a number, never a NaN width", () => {
    renderSummary({
      itemsDone: 0,
      itemsInProgress: 1,
      itemsOpen: 4,
      hoursEstimated: 0,
      hoursDone: 0,
      hoursLeft: 0,
      hoursDonePercent: 0,
      unfinishedWithoutEstimate: 0,
    });
    const hours = cell("Estimated work hours left");
    expect(hours).toHaveTextContent(/^Estimated work hours left0 h$/);
    const fill = hours.querySelector<HTMLElement>("[data-hours-done]");
    expect(fill === null || /^\d/.test(fill.style.width)).toBe(true);
  });

  test("done hours with every unfinished item unestimated: no bar reading finished", () => {
    renderSummary({
      itemsDone: 3,
      itemsInProgress: 1,
      itemsOpen: 4,
      hoursEstimated: 8,
      hoursDone: 8,
      hoursLeft: 0,
      hoursDonePercent: 100,
      unfinishedWithoutEstimate: 5,
    });
    const hours = cell("Estimated work hours left");
    expect(hours).toHaveTextContent("8 of 8 estimated hours done (100%)");
    expect(hours).toHaveTextContent("5 unfinished items have no estimate");
    expect(hours.querySelector("[data-hours-done]")).toBeNull();
  });

  test("some unfinished items estimated at 0 h and the rest unestimated: counts only the unestimated", () => {
    renderSummary({
      itemsDone: 0,
      itemsInProgress: 1,
      itemsOpen: 4,
      hoursEstimated: 0,
      hoursDone: 0,
      hoursLeft: 0,
      hoursDonePercent: 0,
      unfinishedWithoutEstimate: 3,
    });
    const hours = cell("Estimated work hours left");
    expect(hours).not.toHaveTextContent("None of the");
    expect(hours).toHaveTextContent("3 unfinished items have no estimate");
    expect(hours.querySelector("[data-hours-done]")).toBeNull();
  });

  test("everything done: 0 h and a full bar", () => {
    renderSummary({
      itemsDone: 31,
      itemsInProgress: 0,
      itemsOpen: 0,
      donePercent: 100,
      hoursEstimated: 64.5,
      hoursDone: 64.5,
      hoursLeft: 0,
      hoursDonePercent: 100,
      unfinishedWithoutEstimate: 0,
    });
    const hours = cell("Estimated work hours left");
    expect(hours).toHaveTextContent("0 h");
    expect(hours).toHaveTextContent("64.5 of 64.5 estimated hours done (100%)");
    expect(
      hours.querySelector<HTMLElement>("[data-hours-done]")?.style.width,
    ).toBe("100%");
  });
});

describe("ProgressSummary · target", () => {
  const target = (date: string | null) => ({
    target: { date, status: "upcoming" as const, daysAway: 99 },
  });

  test("none: Not set, and no target yet", () => {
    renderSummary({ target: { date: null, status: "none", daysAway: null } });
    expect(cell("Target date")).toHaveTextContent("Not setNo target date yet.");
  });

  test("upcoming counts days from the viewer's today, not the server's", () => {
    renderSummary(target("2026-12-04"));
    expect(cell("Target date")).toHaveTextContent("Dec 4in 6 days");
  });

  test("one day away is singular", () => {
    renderSummary(target("2026-11-29"));
    expect(cell("Target date")).toHaveTextContent("Nov 29in 1 day");
  });

  test("today reads Today", () => {
    renderSummary(target("2026-11-28"));
    expect(cell("Target date")).toHaveTextContent(/^Target dateToday$/);
  });

  test("overdue with work left: the date and the days in destructive ink", () => {
    renderSummary(target("2026-11-24"));
    const targetCell = cell("Target date");
    expect(targetCell).toHaveTextContent("Nov 244 days overdue");
    expect(within(targetCell).getByText("Nov 24")).toHaveClass(
      "text-destructive",
    );
    expect(within(targetCell).getByText("4 days overdue")).toHaveClass(
      "text-destructive",
    );
  });

  test("one day overdue is singular", () => {
    renderSummary(target("2026-11-27"));
    expect(screen.getByText("1 day overdue")).toBeInTheDocument();
  });

  test("past the date with nothing unfinished it is a plain date", () => {
    renderSummary({
      ...target("2026-11-24"),
      itemsDone: 31,
      itemsInProgress: 0,
      itemsOpen: 0,
    });
    const targetCell = cell("Target date");
    expect(targetCell).toHaveTextContent(/^Target dateNov 24$/);
    expect(targetCell.querySelector(".text-destructive")).toBeNull();
  });
});

describe("ByProduct", () => {
  const products = base.byProduct;
  const rows = () => screen.getAllByRole("listitem");

  test("one row per product: key, name, done of scope and the hours line", () => {
    render(<ByProduct products={products} />);
    expect(
      screen.getByRole("heading", { name: "By product" }),
    ).toBeInTheDocument();
    expect(rows().map((r) => r.textContent)).toEqual([
      "DOC Docs site 3 of 8 done9 h left · 2 without an estimate",
      "OPB OpenBot 4 of 5 done1.5 h left",
      "TRL trail 11 of 18 done14 h left",
    ]);
  });

  test("each bar's length is its share of the largest product's scope", () => {
    render(<ByProduct products={products} />);
    const widths = rows().map((r) =>
      Number.parseFloat(
        r.querySelector<HTMLElement>("[data-bar]")?.style.width ?? "",
      ),
    );
    expect(widths[0]).toBeCloseTo((8 / 18) * 100, 3);
    expect(widths[1]).toBeCloseTo((5 / 18) * 100, 3);
    expect(widths[2]).toBe(100);
  });

  test("No estimates yet, and Nothing left", () => {
    render(
      <ByProduct
        products={[
          {
            ...docsSite,
            inScope: 4,
            done: 0,
            inProgress: 1,
            open: 3,
            hoursLeft: 0,
            unfinishedWithoutEstimate: 4,
          },
          {
            ...openBot,
            inScope: 3,
            done: 3,
            inProgress: 0,
            open: 0,
            hoursLeft: 0,
            unfinishedWithoutEstimate: 0,
          },
        ]}
      />,
    );
    expect(rows()[0]).toHaveTextContent(/No estimates yet$/);
    expect(rows()[1]).toHaveTextContent(/Nothing left$/);
  });

  // the server sends every visible product, a triage-only one included
  const emptyOpenBot = {
    ...openBot,
    inScope: 0,
    done: 0,
    inProgress: 0,
    open: 0,
    hoursLeft: 0,
    unfinishedWithoutEstimate: 0,
  };
  const withScope = products.filter((p) => p.key !== openBot.key);

  test("a product with nothing in scope draws no row", () => {
    render(<ByProduct products={[...withScope, emptyOpenBot]} />);
    expect(rows().map((r) => r.textContent)).toEqual([
      "DOC Docs site 3 of 8 done9 h left · 2 without an estimate",
      "TRL trail 11 of 18 done14 h left",
    ]);
  });

  test("one product with scope beside empty ones draws no list", () => {
    const { container } = render(
      <ByProduct products={[emptyOpenBot, ...withScope.slice(1)]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("one visible product draws no list", () => {
    const { container } = render(<ByProduct products={products.slice(2)} />);
    expect(products.slice(2).map((p) => p.key)).toEqual([trail.key]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("BurnUp", () => {
  const history = [
    { date: "2026-10-28", scope: 9, done: 0 },
    { date: "2026-11-12", scope: 18, done: 2 },
    { date: "2026-11-28", scope: 28, done: 5 },
  ];

  test("an image named for its start and end values, end labels and a summary line", () => {
    render(<BurnUp history={history} now={now} />);
    const chart = screen.getByRole("img", {
      name: "Items in scope rose from 9 on Oct 28 to 28 today. Items done rose from 0 to 5.",
    });
    expect(chart.tagName).toBe("svg");
    expect(chart).toHaveTextContent("Scope 28");
    expect(chart).toHaveTextContent("Done 5");
    expect(chart).toHaveTextContent(/Oct 28.*Nov 12.*Nov 28/);
    expect(
      screen.getByText("Since Oct 28: scope 9 to 28 items, done 0 to 5."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Counts today's items by the day each joined the project and finished.",
      ),
    ).toBeInTheDocument();
  });

  test("unchanged values say so", () => {
    render(
      <BurnUp
        history={[
          { date: "2026-11-26", scope: 7, done: 2 },
          { date: "2026-11-28", scope: 7, done: 2 },
        ]}
        now={now}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: "Items in scope stayed at 7 since Nov 26. Items done stayed at 2.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Since Nov 26: scope 7 items, done 2."),
    ).toBeInTheDocument();
  });

  test("a single day draws no chart, only when it started", () => {
    render(
      <BurnUp
        history={[{ date: "2026-11-28", scope: 3, done: 0 }]}
        now={now}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Progress over time" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByText("Started Nov 28. The chart draws from day two."),
    ).toBeInTheDocument();
  });
});
