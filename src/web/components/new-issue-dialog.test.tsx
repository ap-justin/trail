import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  NewIssueDialog,
  type NewIssueDialogProps,
} from "@/components/new-issue-dialog";
import { allProjects } from "@/test/fixtures";

function renderDialog(overrides: Partial<NewIssueDialogProps> = {}) {
  const props: NewIssueDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    projects: allProjects,
    defaultProjectKey: "DOC",
    viewer: { name: "Maya Chen", isOwner: false },
    ownerName: "Justin Salas",
    onSubmit: vi.fn(),
    pending: false,
    error: null,
    ...overrides,
  };
  render(<NewIssueDialog {...props} />);
  return props;
}

const dialog = () => screen.getByRole("dialog", { name: "New issue" });

describe("new issue dialog", () => {
  test("an empty title submit says Add a title., keeps focus on Title and sends nothing", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.type(within(dialog()).getByLabelText("Title"), "   ");
    await user.click(
      within(dialog()).getByRole("button", { name: "Create issue" }),
    );
    const title = within(dialog()).getByLabelText("Title");
    expect(within(dialog()).getByText("Add a title.")).toBeInTheDocument();
    expect(title).toHaveFocus();
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  test("the message clears as soon as a title is typed", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      within(dialog()).getByRole("button", { name: "Create issue" }),
    );
    await user.type(within(dialog()).getByLabelText("Title"), "S");
    expect(
      within(dialog()).queryByText("Add a title."),
    ).not.toBeInTheDocument();
  });

  test("the project defaults to the current one and the issue goes out trimmed", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    expect(within(dialog()).getByLabelText("Project")).toHaveTextContent(
      "DOC Docs site",
    );
    await user.type(
      within(dialog()).getByLabelText("Title"),
      "  Fix the logo  ",
    );
    await user.type(
      within(dialog()).getByLabelText(/^Description/),
      "Vera picks a direction.",
    );
    await user.click(
      within(dialog()).getByRole("button", { name: "Create issue" }),
    );
    expect(props.onSubmit).toHaveBeenCalledWith({
      projectKey: "DOC",
      title: "Fix the logo",
      description: "Vera picks a direction.",
    });
  });

  test("without a current project the first visible one is picked", () => {
    renderDialog({ defaultProjectKey: null });
    expect(within(dialog()).getByLabelText("Project")).toHaveTextContent(
      "TRL trail",
    );
  });

  test('says "Filing as {name}" with the Human badge', () => {
    renderDialog();
    const line = within(dialog()).getByText(/^Filing as/);
    expect(line).toHaveTextContent("Filing as Maya Chen");
    expect(within(line).getByText("Human")).toBeInTheDocument();
  });

  test("Cancel closes without sending", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  test("a click outside keeps the dialog and the draft", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.type(within(dialog()).getByLabelText("Title"), "Fix the logo");
    const backdrop = document.querySelector('[data-slot="dialog-overlay"]');
    if (!backdrop) throw new Error("no backdrop");
    await user.click(backdrop);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(within(dialog()).getByLabelText("Title")).toHaveValue(
      "Fix the logo",
    );
  });

  test("Escape still closes", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.keyboard("{Escape}");
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  test("a title over 300 characters is refused at Title, which takes focus", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    const title = within(dialog()).getByLabelText("Title");
    await user.click(title);
    await user.paste("x".repeat(301));
    await user.click(
      within(dialog()).getByRole("button", { name: "Create issue" }),
    );
    expect(title).toHaveFocus();
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(title).toHaveAccessibleDescription("Keep it to 300 characters.");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  test("a title of exactly 300 characters, padded with spaces, goes out", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(within(dialog()).getByLabelText("Title"));
    await user.paste(`  ${"x".repeat(300)}  `);
    await user.click(
      within(dialog()).getByRole("button", { name: "Create issue" }),
    );
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ title: "x".repeat(300) }),
    );
  });

  test("while pending, Create issue holds and says so", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ pending: true });
    await user.type(within(dialog()).getByLabelText("Title"), "Fix the logo");
    const button = within(dialog()).getByRole("button", { name: "Creating…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  test("with no projects, it asks for access in place of the form", () => {
    renderDialog({ projects: [], defaultProjectKey: null });
    expect(
      within(dialog()).getByRole("heading", { name: "No projects yet" }),
    ).toBeInTheDocument();
    expect(
      within(dialog()).getByText(
        "Ask Justin Salas to give you access to a project.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog()).queryByLabelText("Title")).not.toBeInTheDocument();
    expect(
      within(dialog()).queryByRole("button", { name: "Create issue" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog()).getByRole("button", { name: "Close" }),
    ).toBeInTheDocument();
  });
});
