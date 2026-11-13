import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  PeopleView,
  type PeopleViewProps,
  parseEntry,
  type RowMutation,
} from "@/components/people";
import type { PersonView } from "@/lib/api-types";
import { allProjects, people, photoUrlFor } from "@/test/fixtures";

function renderPeople(overrides: Partial<PeopleViewProps> = {}) {
  const props: PeopleViewProps = {
    status: "ready",
    people,
    projects: allProjects,
    onRetry: vi.fn(),
    onInvite: vi.fn(),
    invitePending: false,
    inviteError: null,
    onSaveProjects: vi.fn(),
    onRemove: vi.fn(),
    rowMutations: [],
    ...overrides,
  };
  const view = render(<PeopleView {...props} />);
  return { props, ...view };
}

const row = (username: string) => {
  const item = document.querySelector<HTMLElement>(
    `[data-person="${username}"]`,
  );
  if (!item) throw new Error(`no row for ${username}`);
  return within(item);
};

describe("people list", () => {
  test("a person with a photo shows it; one without shows initials", () => {
    renderPeople({
      people: people.map((p) =>
        p.username === "mayachen"
          ? { ...p, photoUrl: photoUrlFor("a-maya", "77") }
          : p,
      ),
    });
    const avatar = (username: string) =>
      document.querySelector(`[data-person="${username}"] [data-actor-kind]`);
    expect(avatar("mayachen")?.querySelector("img")).toHaveAttribute(
      "src",
      photoUrlFor("a-maya", "77"),
    );
    expect(avatar("justinsalas")).toHaveTextContent("JS");
    expect(avatar("justinsalas")?.querySelector("img")).toBeNull();
  });

  test("a pending invite shows a dashed ? circle; a signed-in person with no name still shows ?", () => {
    renderPeople({
      people: people.map((p) =>
        p.username === "mayachen" ? { ...p, name: null } : p,
      ),
    });
    const pending = document.querySelector(
      '[data-person="kai-dev"] .border-dashed',
    );
    expect(pending).toHaveTextContent("?");
    expect(pending).toHaveClass("rounded-full");
    expect(
      document.querySelector('[data-person="kai-dev"] [data-actor-kind]'),
    ).toBeNull();

    const unnamed = document.querySelector(
      '[data-person="mayachen"] [data-actor-kind]',
    );
    expect(unnamed).toHaveTextContent("?");
    expect(
      document.querySelector('[data-person="mayachen"] .border-dashed'),
    ).toBeNull();
  });

  test("the owner row comes first and has no actions", () => {
    renderPeople();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveAttribute("data-person", "justinsalas");
    expect(row("justinsalas").queryAllByRole("button")).toEqual([]);
    expect(row("justinsalas").getByText("Owner")).toBeInTheDocument();
  });

  test("other rows name the person on each control", () => {
    renderPeople();
    expect(
      row("mayachen").getByRole("button", {
        name: "Edit projects for @mayachen",
      }),
    ).toBeInTheDocument();
    expect(
      row("mayachen").getByRole("button", { name: "Remove @mayachen" }),
    ).toBeInTheDocument();
  });

  test('a pending invite says "Invited · hasn\'t signed in"', () => {
    renderPeople();
    expect(
      row("kai-dev").getByText("Invited · hasn't signed in"),
    ).toBeInTheDocument();
  });

  test('Remove asks "Remove @user?"; Keep backs out and only Remove calls back', async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.click(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    );
    expect(row("kai-dev").getByText("Remove @kai-dev?")).toBeInTheDocument();
    const keep = row("kai-dev").getByRole("button", { name: "Keep" });
    expect(keep).toHaveFocus();
    await user.click(keep);
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(
      row("kai-dev").queryByText("Remove @kai-dev?"),
    ).not.toBeInTheDocument();
    expect(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    ).toHaveFocus();

    await user.click(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    );
    const confirm = row("kai-dev").getByRole("group", {
      name: "Remove @kai-dev",
    });
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(props.onRemove).toHaveBeenCalledExactlyOnceWith("kai-dev");
  });

  test("Edit projects ticks the current projects and Save projects sends the new set", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.click(
      row("mayachen").getByRole("button", {
        name: "Edit projects for @mayachen",
      }),
    );
    const trail = row("mayachen").getByRole("checkbox", { name: "TRL trail" });
    expect(trail).toBeChecked();
    expect(trail).toHaveFocus();
    expect(
      row("mayachen").getByRole("checkbox", { name: "OPB OpenBot" }),
    ).not.toBeChecked();
    await user.click(trail);
    await user.click(
      row("mayachen").getByRole("checkbox", { name: "OPB OpenBot" }),
    );
    await user.click(
      row("mayachen").getByRole("button", { name: "Save projects" }),
    );
    expect(props.onSaveProjects).toHaveBeenCalledWith("mayachen", [
      "DOC",
      "OPB",
    ]);
  });

  test("Cancel leaves the projects as they were", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.click(
      row("mayachen").getByRole("button", {
        name: "Edit projects for @mayachen",
      }),
    );
    await user.click(row("mayachen").getByRole("button", { name: "Cancel" }));
    expect(props.onSaveProjects).not.toHaveBeenCalled();
    expect(row("mayachen").queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

const failedSave = (id: string): RowMutation => ({
  id,
  action: "save",
  pending: false,
  error: "Couldn't save. Try again.",
});

describe("after a row changes", () => {
  async function confirmRemove(username: string) {
    const user = userEvent.setup();
    await user.click(
      row(username).getByRole("button", { name: `Remove @${username}` }),
    );
    await user.click(
      within(
        row(username).getByRole("group", { name: `Remove @${username}` }),
      ).getByRole("button", { name: "Remove" }),
    );
  }

  test("removing a person moves focus to the next row's Edit projects", async () => {
    const { props, rerender } = renderPeople();
    await confirmRemove("mayachen");
    rerender(
      <PeopleView
        {...props}
        people={people.filter((p) => p.username !== "mayachen")}
      />,
    );
    expect(
      row("kai-dev").getByRole("button", {
        name: "Edit projects for @kai-dev",
      }),
    ).toHaveFocus();
  });

  test("removing the last person moves focus to the People heading", async () => {
    const { props, rerender } = renderPeople();
    await confirmRemove("kai-dev");
    rerender(
      <PeopleView
        {...props}
        people={people.filter((p) => p.username !== "kai-dev")}
      />,
    );
    expect(screen.getByRole("heading", { name: /^People/ })).toHaveFocus();
  });

  test("a failed remove is announced through a status already in place", async () => {
    const { props, rerender } = renderPeople();
    await confirmRemove("kai-dev");
    const status = row("kai-dev").getByRole("status");
    expect(status).toHaveTextContent(/^$/);
    rerender(
      <PeopleView
        {...props}
        rowMutations={[
          {
            id: "kai-dev",
            action: "remove",
            pending: false,
            error: "Couldn't remove @kai-dev. Try again.",
          },
        ]}
      />,
    );
    expect(row("kai-dev").getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Couldn't remove @kai-dev. Try again.");
  });

  test("a failed save is announced through a status already in place", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderPeople();
    await user.click(
      row("kai-dev").getByRole("button", {
        name: "Edit projects for @kai-dev",
      }),
    );
    const status = row("kai-dev").getByRole("status");
    expect(status).toHaveTextContent(/^$/);
    await user.click(
      row("kai-dev").getByRole("button", { name: "Save projects" }),
    );
    rerender(<PeopleView {...props} rowMutations={[failedSave("kai-dev")]} />);
    expect(row("kai-dev").getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Couldn't save. Try again.");
  });

  async function saveFor(username: string) {
    const user = userEvent.setup();
    await user.click(
      row(username).getByRole("button", {
        name: `Edit projects for @${username}`,
      }),
    );
    await user.click(
      row(username).getByRole("button", { name: "Save projects" }),
    );
    return user;
  }

  test("a row stays in edit mode until its own save settles, whatever other rows do", async () => {
    const { props, rerender } = renderPeople();
    await saveFor("mayachen");
    const savingMaya: RowMutation = {
      id: "mayachen",
      action: "save",
      pending: true,
      error: null,
    };
    const removingKai: RowMutation = {
      id: "kai-dev",
      action: "remove",
      pending: true,
      error: null,
    };
    rerender(
      <PeopleView {...props} rowMutations={[savingMaya, removingKai]} />,
    );
    rerender(<PeopleView {...props} rowMutations={[savingMaya]} />);
    expect(
      row("mayachen").getByRole("button", { name: "Saving…" }),
    ).toBeInTheDocument();
    rerender(<PeopleView {...props} rowMutations={[]} />);
    expect(row("mayachen").queryByRole("checkbox")).not.toBeInTheDocument();
  });

  test("one row's write in flight leaves the other rows free to save", async () => {
    const { props } = renderPeople({
      rowMutations: [
        { id: "kai-dev", action: "save", pending: true, error: null },
      ],
    });
    await saveFor("mayachen");
    expect(props.onSaveProjects).toHaveBeenCalledExactlyOnceWith("mayachen", [
      "TRL",
      "DOC",
    ]);
  });

  test("a failed save doesn't show under Remove after Cancel", async () => {
    const { props, rerender } = renderPeople();
    const user = await saveFor("kai-dev");
    rerender(<PeopleView {...props} rowMutations={[failedSave("kai-dev")]} />);
    await user.click(row("kai-dev").getByRole("button", { name: "Cancel" }));
    await user.click(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    );
    expect(row("kai-dev").getByText("Remove @kai-dev?")).toBeInTheDocument();
    expect(row("kai-dev").getByRole("status")).toHaveTextContent(/^$/);
  });

  test("Edit projects opened again starts without the last failure", async () => {
    const { props, rerender } = renderPeople();
    const user = await saveFor("kai-dev");
    rerender(<PeopleView {...props} rowMutations={[failedSave("kai-dev")]} />);
    await user.click(row("kai-dev").getByRole("button", { name: "Cancel" }));
    await user.click(
      row("kai-dev").getByRole("button", {
        name: "Edit projects for @kai-dev",
      }),
    );
    expect(row("kai-dev").getByRole("status")).toHaveTextContent(/^$/);
  });

  test("a remove that fails after Keep reports on the row", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderPeople();
    await confirmRemove("kai-dev");
    const removing: RowMutation = {
      id: "kai-dev",
      action: "remove",
      pending: true,
      error: null,
    };
    rerender(<PeopleView {...props} rowMutations={[removing]} />);
    await user.click(row("kai-dev").getByRole("button", { name: "Keep" }));
    const status = row("kai-dev").getByRole("status");
    expect(status).toHaveTextContent(/^$/);
    rerender(
      <PeopleView
        {...props}
        rowMutations={[
          { ...removing, pending: false, error: "Couldn't remove @kai-dev." },
        ]}
      />,
    );
    expect(status).toHaveTextContent("Couldn't remove @kai-dev.");
    expect(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    ).toBeInTheDocument();
  });

  test("Escape cancels Edit projects and focus returns to Edit projects", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.click(
      row("mayachen").getByRole("button", {
        name: "Edit projects for @mayachen",
      }),
    );
    await user.keyboard("{Escape}");
    expect(row("mayachen").queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      row("mayachen").getByRole("button", {
        name: "Edit projects for @mayachen",
      }),
    ).toHaveFocus();
    expect(props.onSaveProjects).not.toHaveBeenCalled();
  });

  test("Escape backs out of Remove and focus returns to Remove", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.click(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    );
    await user.keyboard("{Escape}");
    expect(
      row("kai-dev").queryByText("Remove @kai-dev?"),
    ).not.toBeInTheDocument();
    expect(
      row("kai-dev").getByRole("button", { name: "Remove @kai-dev" }),
    ).toHaveFocus();
    expect(props.onRemove).not.toHaveBeenCalled();
  });
});

describe("people invited by email", () => {
  const dana: PersonView = {
    username: null,
    email: "dana@example.com",
    owner: false,
    pending: false,
    name: "dana.okafor",
    photoUrl: null,
    projects: [{ key: "TRL", name: "trail" }],
    invitedAt: "2026-11-12T10:00:00.000Z",
  };
  const sam: PersonView = {
    ...dana,
    email: "sam@studio.example",
    pending: true,
    name: null,
    projects: [],
  };
  const withEmailPeople = () =>
    renderPeople({ people: [...people, dana, sam] });

  test("a signed-in one shows their address in mono where @username goes, under their name", () => {
    withEmailPeople();
    expect(
      row("dana@example.com").getByText("dana.okafor"),
    ).toBeInTheDocument();
    expect(row("dana@example.com").getByText("dana@example.com")).toHaveClass(
      "font-mono",
    );
  });

  test("a signed-in one has a round, neutral initials avatar and no photo", () => {
    withEmailPeople();
    const avatar = document.querySelector(
      '[data-person="dana@example.com"] [data-actor-kind]',
    );
    expect(avatar).toHaveAttribute("data-actor-kind", "human");
    expect(avatar).toHaveClass("rounded-full", "bg-muted");
    expect(avatar).not.toHaveClass("bg-bot-muted");
    expect(avatar).toHaveTextContent("DO");
    expect(avatar?.querySelector("img")).toBeNull();
  });

  test("a pending one is named by the address, with its initials in the dashed circle", () => {
    withEmailPeople();
    expect(
      row("sam@studio.example").getByText("sam@studio.example"),
    ).toBeInTheDocument();
    expect(
      row("sam@studio.example").getByText("Invited · hasn't signed in"),
    ).toBeInTheDocument();
    const pending = document.querySelector(
      '[data-person="sam@studio.example"] .border-dashed',
    );
    expect(pending).toHaveTextContent("SA");
    expect(pending).toHaveClass("rounded-full");
  });

  test("each control names the person by their address", () => {
    withEmailPeople();
    expect(
      row("dana@example.com").getByRole("button", {
        name: "Edit projects for dana@example.com",
      }),
    ).toBeInTheDocument();
  });

  test("Remove and Save projects call back with the address", async () => {
    const user = userEvent.setup();
    const { props } = withEmailPeople();
    await user.click(
      screen.getByRole("button", { name: "Remove dana@example.com" }),
    );
    expect(
      row("dana@example.com").getByText("Remove dana@example.com?"),
    ).toBeInTheDocument();
    await user.click(
      row("dana@example.com").getByRole("button", { name: "Remove" }),
    );
    expect(props.onRemove).toHaveBeenCalledWith("dana@example.com");

    await user.click(
      screen.getByRole("button", {
        name: "Edit projects for sam@studio.example",
      }),
    );
    await user.click(
      row("sam@studio.example").getByRole("checkbox", { name: "OPB OpenBot" }),
    );
    await user.click(
      row("sam@studio.example").getByRole("button", { name: "Save projects" }),
    );
    expect(props.onSaveProjects).toHaveBeenCalledWith("sam@studio.example", [
      "OPB",
    ]);
  });
});

describe("invite", () => {
  const entry = () =>
    screen.getByRole("textbox", { name: "GitHub username or email" });

  test("shows the line about how each kind signs in and what they'll see", () => {
    renderPeople();
    expect(entry()).toHaveAccessibleDescription(
      "GitHub invitees sign in with GitHub; email invitees get a sign-in link by email. They see only the projects you pick.",
    );
  });

  test.each(["devon@", "devon--r", "", "dev on@example.com"])(
    "%j gets the inline message, focus, and no invite",
    async (typed) => {
      const user = userEvent.setup();
      const { props } = renderPeople();
      if (typed) await user.type(entry(), typed);
      await user.click(screen.getByRole("button", { name: "Invite" }));
      expect(entry()).toHaveFocus();
      expect(entry()).toHaveAttribute("aria-invalid", "true");
      expect(
        screen.getByText(
          "Enter a GitHub username or an email address, like devon-r or devon@example.com.",
        ),
      ).toBeInTheDocument();
      expect(props.onInvite).not.toHaveBeenCalled();
    },
  );

  test("the message clears as soon as the entry is fixed", async () => {
    const user = userEvent.setup();
    renderPeople();
    await user.type(entry(), "devon@");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await user.type(entry(), "example.com");
    expect(entry()).not.toHaveAttribute("aria-invalid");
  });

  test("an email address goes out trimmed and lowercased", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.type(entry(), " Priya@Studio.example ");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(props.onInvite).toHaveBeenCalledWith({
      username: "priya@studio.example",
      projectKeys: [],
    });
  });

  test("an empty project set is allowed; the username goes out lowercased without the @", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.type(entry(), " @Devon-R ");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(props.onInvite).toHaveBeenCalledWith({
      username: "devon-r",
      projectKeys: [],
    });
  });

  test("projects picked in the popover go with the invite", async () => {
    const user = userEvent.setup();
    const { props } = renderPeople();
    await user.type(entry(), "devon-r");
    await user.click(screen.getByRole("button", { name: /^Projects:/ }));
    await user.click(
      await screen.findByRole("checkbox", { name: "TRL trail" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "DOC Docs site" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(props.onInvite).toHaveBeenCalledWith({
      username: "devon-r",
      projectKeys: ["TRL", "DOC"],
    });
  });
});

describe("invite failure", () => {
  const already = {
    message:
      "dana@example.com is already invited. Change their projects in the list below.",
    atField: true,
  };

  async function inviteThenFail(error: PeopleViewProps["inviteError"]) {
    const user = userEvent.setup();
    const { props, rerender } = renderPeople();
    const input = screen.getByRole("textbox", {
      name: "GitHub username or email",
    });
    await user.type(input, "dana@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    rerender(<PeopleView {...props} invitePending />);
    rerender(<PeopleView {...props} inviteError={error} />);
    return { user, input };
  }

  test("already invited: the field is marked, the message sits under it, and focus moves there", async () => {
    const { input } = await inviteThenFail(already);
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining(already.message),
    );
    expect(screen.getAllByRole("status")[0]).toBeEmptyDOMElement();
  });

  test("clears once the entry is edited", async () => {
    const { user, input } = await inviteThenFail(already);
    await user.type(input, "x");
    expect(screen.queryByText(already.message)).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  test("a failure that isn't about the entry is announced below the form, the field unmarked", async () => {
    const { input } = await inviteThenFail({
      message: "Couldn't reach trail. Check your connection, then try again.",
      atField: false,
    });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Couldn't reach trail. Check your connection, then try again.",
    );
  });
});

describe("parseEntry", () => {
  test.each([
    ["devon-r", "devon-r"],
    ["@Devon-R", "devon-r"],
    ["a", "a"],
    ["a".repeat(39), "a".repeat(39)],
    [" Dana@Example.com ", "dana@example.com"],
  ])("accepts %s", (raw, parsed) => {
    expect(parseEntry(raw)).toBe(parsed);
  });

  test.each([
    "",
    "-devon",
    "devon-",
    "dev--on",
    "dev_on",
    "a".repeat(40),
    "devon@",
    "@devon@example",
  ])("refuses %j", (raw) => {
    expect(parseEntry(raw)).toBeNull();
  });
});
