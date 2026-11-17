import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderIcon } from "lucide-react";
import { describe, expect, test, vi } from "vitest";
import { FilterSelect, FiltersSheet } from "@/components/filter-select";

const options = [
  {
    value: "a",
    label: "Alpha",
    before: <i data-testid="before-a">B</i>,
    after: <b data-testid="after-a">Lead</b>,
  },
  { value: "b", label: "Beta" },
];

function renderSelect(
  props: Partial<Parameters<typeof FilterSelect<string>>[0]> = {},
) {
  const onChange = vi.fn();
  render(
    <FilterSelect
      label="Filter by bot"
      allLabel="All bots"
      icon={FolderIcon}
      options={options}
      value={null}
      onChange={onChange}
      {...props}
    />,
  );
  return onChange;
}

describe("FilterSelect as a chip", () => {
  test("is named by label and shows the All label until something is chosen", () => {
    renderSelect();
    expect(
      screen.getByRole("combobox", { name: "Filter by bot" }),
    ).toHaveTextContent("All bots");
  });

  test("shows the chosen label alone, without the option's before slot", () => {
    renderSelect({ value: "a" });
    const chip = screen.getByRole("combobox", { name: "Filter by bot" });
    expect(chip).toHaveTextContent("Alpha");
    expect(within(chip).queryByTestId("before-a")).toBeNull();
  });

  test("a value gone from the options reads as the All label", () => {
    renderSelect({ value: "gone" });
    expect(
      screen.getByRole("combobox", { name: "Filter by bot" }),
    ).toHaveTextContent("All bots");
  });

  test("the menu lists All first, flanks a label with its before and after, and picking All reports null", async () => {
    const user = userEvent.setup();
    const onChange = renderSelect({ value: "a" });
    await user.click(screen.getByRole("combobox"));
    const listed = await screen.findAllByRole("option");
    expect(listed.map((o) => o.textContent)).toEqual([
      "All bots",
      "B AlphaLead",
      "Beta",
    ]);
    expect(listed[1]).toHaveAttribute("aria-selected", "true");
    expect(listed[0]).toHaveAttribute("aria-selected", "false");
    await user.click(listed[0] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(null, expect.anything());
  });
});

describe("FilterSelect with a fieldLabel", () => {
  test("the word names the trigger, and the chosen option's before sits beside its label", () => {
    renderSelect({ fieldLabel: "Bot", value: "a" });
    const field = screen.getByRole("combobox", { name: "Bot" });
    expect(within(field).getByTestId("before-a")).toBeInTheDocument();
    expect(field).toHaveTextContent("Alpha");
    expect(within(field).queryByTestId("after-a")).toBeNull();
  });

  test("nothing chosen, or a value gone from the options, reads as the All label", () => {
    renderSelect({ fieldLabel: "Bot", value: "gone" });
    expect(screen.getByRole("combobox", { name: "Bot" })).toHaveTextContent(
      "All bots",
    );
  });

  test("choosing an option reports its value", async () => {
    const user = userEvent.setup();
    const onChange = renderSelect({ fieldLabel: "Bot" });
    await user.click(screen.getByRole("combobox", { name: "Bot" }));
    await user.click(await screen.findByRole("option", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b", expect.anything());
  });
});

describe("FiltersSheet", () => {
  test("the button counts filters in force, and says nothing at zero", () => {
    const { rerender } = render(
      <FiltersSheet activeCount={0} doneLabel="Show events">
        x
      </FiltersSheet>,
    );
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    rerender(
      <FiltersSheet activeCount={3} doneLabel="Show events">
        x
      </FiltersSheet>,
    );
    expect(
      screen.getByRole("button", { name: "Filters 3 in use" }),
    ).toBeInTheDocument();
  });
});
