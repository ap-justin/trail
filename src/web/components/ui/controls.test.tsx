import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// jsdom lays nothing out, so the states are read off the classes that draw them

const focusRing = [
  "focus-visible:outline-2",
  "focus-visible:outline-offset-2",
  "focus-visible:outline-ring",
];
const disabledLook = [
  "disabled:bg-muted",
  "disabled:text-muted-foreground",
  "disabled:border-input",
];

const controls: [string, () => ReactElement, () => HTMLElement][] = [
  ["Button", () => <Button>Save</Button>, () => screen.getByRole("button")],
  [
    "Input",
    () => <Input aria-label="Title" />,
    () => screen.getByRole("textbox"),
  ],
  [
    "Textarea",
    () => <Textarea aria-label="Comment" />,
    () => screen.getByRole("textbox"),
  ],
  [
    "SelectTrigger",
    () => (
      <Select>
        <SelectTrigger aria-label="Product">
          <SelectValue />
        </SelectTrigger>
      </Select>
    ),
    () => screen.getByRole("combobox"),
  ],
];

describe.each(controls)("%s", (_name, ui, element) => {
  test("focus draws the 2px outline in --ring, offset 2px, and no ring", () => {
    render(ui());
    expect(element()).toHaveClass(...focusRing);
    expect(element().className).not.toMatch(/\bfocus-visible:ring/);
  });

  test("disabled is muted ground and ink on the input border, never faded", () => {
    render(ui());
    expect(element()).toHaveClass(...disabledLook);
    expect(element().className).not.toMatch(/opacity-/);
  });
});

test("the input and the select trigger are 44px below lg, 32 from lg", () => {
  render(
    <>
      <Input aria-label="Title" />
      <Select>
        <SelectTrigger aria-label="Product">
          <SelectValue />
        </SelectTrigger>
      </Select>
    </>,
  );
  expect(screen.getByRole("textbox")).toHaveClass("h-11", "lg:h-8");
  expect(screen.getByRole("combobox")).toHaveClass(
    "data-[size=default]:h-11",
    "data-[size=default]:lg:h-8",
  );
});

describe("Button", () => {
  test("from lg: default 32, sm 28; 44 below", () => {
    render(
      <>
        <Button>Default</Button>
        <Button size="sm">Small</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Default" })).toHaveClass(
      "h-11",
      "lg:h-8",
    );
    expect(screen.getByRole("button", { name: "Small" })).toHaveClass(
      "h-11",
      "lg:h-7",
    );
  });

  test("the outline variant edges on the control border", () => {
    render(<Button variant="outline">Filters</Button>);
    expect(screen.getByRole("button")).toHaveClass("border-input");
  });

  test("a focusable disabled button (aria-disabled) looks disabled too", () => {
    render(
      <Button disabled focusableWhenDisabled>
        Comment
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveClass(
      "aria-disabled:bg-muted",
      "aria-disabled:text-muted-foreground",
      "aria-disabled:border-input",
    );
  });
});

describe("Checkbox", () => {
  test("focus draws the 2px outline, and disabled never fades", () => {
    render(<Checkbox aria-label="trail" />);
    const box = screen.getByRole("checkbox");
    expect(box).toHaveClass(...focusRing);
    expect(box.className).not.toMatch(/opacity-/);
  });
});

describe("Tabs", () => {
  test("the line list is a full-width rule; the active tab's 2px underline is ink", () => {
    render(
      <Tabs defaultValue="all">
        <TabsList variant="line" aria-label="Filter by status">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="open">Open</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tablist")).toHaveClass(
      "data-[variant=line]:w-full",
      "data-[variant=line]:border-b",
    );
    const tab = screen.getByRole("tab", { name: "All" });
    expect(tab).toHaveClass(
      "group-data-horizontal/tabs:after:h-0.5",
      "after:bg-foreground",
      "focus-visible:outline-2",
      "focus-visible:-outline-offset-2",
      "focus-visible:outline-ring",
    );
  });

  test("44px below lg", () => {
    render(
      <Tabs defaultValue="all">
        <TabsList variant="line" aria-label="Show">
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tab")).toHaveClass("max-lg:h-11");
  });
});

describe("Toggle", () => {
  test("pressed styles from aria-pressed, the state Base UI sets; no Radix data-state", () => {
    render(<Toggle defaultPressed>Bold</Toggle>);
    const toggle = screen.getByRole("button", { name: "Bold" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("aria-pressed:bg-muted");
    expect(toggle.className).not.toMatch(/data-\[state=/);
  });
});

test("a select option is 44px below lg", async () => {
  render(
    <Select defaultOpen>
      <SelectTrigger aria-label="Product">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="TRL">trail</SelectItem>
      </SelectContent>
    </Select>,
  );
  expect(await screen.findByRole("option", { name: "trail" })).toHaveClass(
    "min-h-11",
    "lg:min-h-0",
  );
});

describe("ToggleGroup", () => {
  test("segmented: a muted track; the pressed segment is a raised, edged chip", () => {
    render(
      <ToggleGroup variant="segmented" aria-label="Type" defaultValue={["all"]}>
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="issue">Issues</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(screen.getByRole("group", { name: "Type" })).toHaveClass(
      "data-[variant=segmented]:bg-muted",
    );
    const all = screen.getByRole("button", { name: "All" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveClass(
      "aria-pressed:bg-background",
      "aria-pressed:border-border",
      "h-10",
      "lg:h-7",
      ...focusRing,
    );
  });
});

describe("Badge", () => {
  test("tag: a neutral chip on the accent surface, no edge", () => {
    render(<Badge variant="tag">trail</Badge>);
    const tag = screen.getByText("trail");
    expect(tag).toHaveClass("bg-accent", "rounded-sm", "text-foreground");
    expect(tag).not.toHaveClass("border-border");
  });
});

describe("Table", () => {
  test("headers are 12px grey with no fill; rows rule in --rule", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>TRL-1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("columnheader")).toHaveClass(
      "text-xs",
      "text-muted-foreground",
    );
    expect(screen.getByRole("columnheader").className).not.toMatch(/\bbg-/);
    const [, row] = screen.getAllByRole("row");
    expect(row).toHaveClass("border-b", "border-rule");
  });
});
