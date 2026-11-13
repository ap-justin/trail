import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { PersonView } from "@/lib/api-types";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { people } from "@/test/fixtures";
import { server } from "@/test/server";

type Write = { method: string; path: string; body: unknown };

/** Serves /people from a list the writes change, recording each write. */
function servePeople() {
  let list: PersonView[] = structuredClone(people);
  const writes: Write[] = [];
  const record = async (request: Request) => {
    const url = new URL(request.url);
    const text = await request.text();
    writes.push({
      method: request.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : null,
    });
  };
  const person = (entry: string, projectKeys: string[]): PersonView => ({
    username: entry.includes("@") ? null : entry,
    email: entry.includes("@") ? entry : null,
    owner: false,
    pending: true,
    name: null,
    photoUrl: null,
    projects: projectKeys.map((key) => ({ key, name: key })),
    invitedAt: "2026-11-11T10:00:00.000Z",
  });
  server.use(
    http.get("/api/web/people", () => HttpResponse.json({ items: list })),
    http.post("/api/web/people", async ({ request }) => {
      await record(request);
      const { username } = (writes.at(-1)?.body ?? {}) as { username: string };
      const added = person(username, []);
      list = [...list, added];
      return HttpResponse.json(added, { status: 201 });
    }),
    http.put("/api/web/people/:username", async ({ request, params }) => {
      await record(request);
      const updated = person(String(params.username), ["TRL"]);
      list = list.map((p) =>
        (p.username ?? p.email) === params.username ? updated : p,
      );
      return HttpResponse.json(updated);
    }),
    http.delete("/api/web/people/:username", async ({ request, params }) => {
      await record(request);
      list = list.filter((p) => (p.username ?? p.email) !== params.username);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return writes;
}

/**
 * Holds each PUT or DELETE on a person until the test lets it go: `release` hands it on to
 * servePeople's handler, `fail` answers it with a 500 carrying `message`.
 */
function holdWrites(method: "put" | "delete") {
  const held = new Map<string, (answer?: Response) => void>();
  server.use(
    http[method](
      "/api/web/people/:username",
      ({ params }) =>
        new Promise<Response | undefined>((resolve) => {
          held.set(String(params.username), resolve);
        }),
    ),
  );
  const answer = async (username: string, response?: Response) => {
    await waitFor(() => expect(held.has(username)).toBe(true));
    held.get(username)?.(response);
    held.delete(username);
  };
  return {
    release: (username: string) => answer(username),
    fail: (username: string, message: string) =>
      answer(
        username,
        HttpResponse.json(
          { error: { code: "internal", message } },
          { status: 500 },
        ),
      ),
  };
}

function row(username: string) {
  const li = document.querySelector<HTMLElement>(
    `li[data-person="${username}"]`,
  );
  if (!li) throw new Error(`no row for @${username}`);
  return within(li);
}

async function startSave(username: string) {
  await userEvent.click(
    screen.getByRole("button", { name: `Edit projects for @${username}` }),
  );
  await userEvent.click(
    row(username).getByRole("button", { name: "Save projects" }),
  );
}

describe("owner only", () => {
  test("a member has no People nav item, and /people is Not found", async () => {
    signedInAs("member");
    serveFeed();
    renderApp("/");
    await screen.findByText("No activity yet");
    expect(
      screen.queryByRole("link", { name: "People" }),
    ).not.toBeInTheDocument();
  });

  test("a member visiting /people sees Not found, and people are never read", async () => {
    signedInAs("member");
    renderApp("/people");
    expect(
      await screen.findByRole("heading", { name: "Page not found", level: 1 }),
    ).toBeInTheDocument();
  });

  test("the owner has the nav item and the list", async () => {
    signedInAs("owner");
    servePeople();
    renderApp("/people");
    expect(await screen.findByText("@kai-dev")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "People" })).not.toHaveLength(0);
  });
});

describe("managing people", () => {
  test("Invite posts the username and the list shows them", async () => {
    signedInAs("owner");
    const writes = servePeople();
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.type(
      screen.getByLabelText("GitHub username or email"),
      "newbie",
    );
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("@newbie")).toBeInTheDocument();
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/web/people",
        body: { username: "newbie", projectKeys: [] },
      },
    ]);
  });

  test("Save projects puts the chosen keys and the row refreshes", async () => {
    signedInAs("owner");
    const writes = servePeople();
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.click(
      screen.getByRole("button", { name: "Edit projects for @mayachen" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save projects" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: "PUT",
      path: "/api/web/people/mayachen",
    });
    // the server's answer drops her name: the row shows the re-read list
    await waitFor(() =>
      expect(screen.getAllByText("Invited · hasn't signed in")).toHaveLength(2),
    );
  });

  test("Save projects puts exactly the boxes left checked, after a change", async () => {
    signedInAs("owner");
    const writes = servePeople();
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.click(
      screen.getByRole("button", { name: "Edit projects for @mayachen" }),
    );
    // she starts on TRL and DOC: drop TRL, add OPB
    await userEvent.click(
      row("mayachen").getByRole("checkbox", { name: /TRL/ }),
    );
    await userEvent.click(
      row("mayachen").getByRole("checkbox", { name: /OPB/ }),
    );
    await userEvent.click(
      row("mayachen").getByRole("button", { name: "Save projects" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ projectKeys: ["DOC", "OPB"] });
  });

  test("Remove deletes the person and the row goes", async () => {
    signedInAs("owner");
    const writes = servePeople();
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove @mayachen" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Remove @mayachen" }),
      ).not.toBeInTheDocument(),
    );
    expect(writes).toEqual([
      { method: "DELETE", path: "/api/web/people/mayachen", body: null },
    ]);
  });

  test("a second row's Save runs while the first row's is still in flight", async () => {
    signedInAs("owner");
    const writes = servePeople();
    const puts = holdWrites("put");
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await startSave("mayachen");
    await startSave("kai-dev");
    expect(
      row("kai-dev").getByRole("button", { name: "Saving…" }),
    ).toBeInTheDocument();

    await puts.release("kai-dev");
    expect(
      await row("kai-dev").findByRole("button", {
        name: "Edit projects for @kai-dev",
      }),
    ).toBeInTheDocument();
    expect(
      row("mayachen").getByRole("button", { name: "Saving…" }),
    ).toBeInTheDocument();

    await puts.release("mayachen");
    expect(
      await row("mayachen").findByRole("button", {
        name: "Edit projects for @mayachen",
      }),
    ).toBeInTheDocument();
    expect(writes.map((write) => write.path)).toEqual([
      "/api/web/people/kai-dev",
      "/api/web/people/mayachen",
    ]);
  });

  test("Remove on one row leaves another row's running save alone, and its failure lands there", async () => {
    signedInAs("owner");
    servePeople();
    const puts = holdWrites("put");
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await startSave("mayachen");
    await userEvent.click(
      screen.getByRole("button", { name: "Remove @kai-dev" }),
    );
    await userEvent.click(
      row("kai-dev").getByRole("button", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(
        document.querySelector('li[data-person="kai-dev"]'),
      ).not.toBeInTheDocument(),
    );
    expect(
      row("mayachen").getByRole("button", { name: "Saving…" }),
    ).toBeInTheDocument();

    await puts.fail("mayachen", "Couldn't save projects");
    expect(
      await row("mayachen").findByText("Couldn't save projects"),
    ).toBeInTheDocument();
    expect(
      row("mayachen").getByRole("button", { name: "Save projects" }),
    ).toBeInTheDocument();
  });

  test("a failed Remove reports on its own row while another row's Remove goes through", async () => {
    signedInAs("owner");
    servePeople();
    const deletes = holdWrites("delete");
    renderApp("/people");
    await screen.findByText("@kai-dev");
    for (const username of ["mayachen", "kai-dev"]) {
      await userEvent.click(
        screen.getByRole("button", { name: `Remove @${username}` }),
      );
      await userEvent.click(
        row(username).getByRole("button", { name: "Remove" }),
      );
    }
    expect(
      row("kai-dev").getByRole("button", { name: "Removing…" }),
    ).toBeInTheDocument();

    await deletes.fail("kai-dev", "Couldn't remove @kai-dev");
    expect(
      await row("kai-dev").findByText("Couldn't remove @kai-dev"),
    ).toBeInTheDocument();
    expect(
      row("mayachen").getByRole("button", { name: "Removing…" }),
    ).toBeInTheDocument();

    await deletes.release("mayachen");
    await waitFor(() =>
      expect(
        document.querySelector('li[data-person="mayachen"]'),
      ).not.toBeInTheDocument(),
    );
    expect(
      row("kai-dev").getByText("Couldn't remove @kai-dev"),
    ).toBeInTheDocument();
  });

  test("already invited: the server's message sits at the field", async () => {
    signedInAs("owner");
    servePeople();
    server.use(
      http.post("/api/web/people", () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message:
                "@mayachen is already invited. Change their projects in the list below.",
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.type(
      screen.getByLabelText("GitHub username or email"),
      "mayachen",
    );
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    const field = screen.getByLabelText("GitHub username or email");
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveAccessibleDescription(
      expect.stringContaining(
        "@mayachen is already invited. Change their projects in the list below.",
      ),
    );
  });

  test("a GitHub handle typed with its @ is invited and then removed by the bare username", async () => {
    signedInAs("owner");
    const writes = servePeople();
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.type(
      screen.getByLabelText("GitHub username or email"),
      "@Newbie",
    );
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("@newbie")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit projects for @newbie" }),
    );
    await userEvent.click(
      row("newbie").getByRole("button", { name: "Save projects" }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove @newbie" }),
    );
    await userEvent.click(
      row("newbie").getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(writes).toHaveLength(3));
    expect(
      writes.map(({ method, path, body }) => [method, path, body]),
    ).toEqual([
      ["POST", "/api/web/people", { username: "newbie", projectKeys: [] }],
      ["PUT", "/api/web/people/newbie", { projectKeys: [] }],
      ["DELETE", "/api/web/people/newbie", null],
    ]);
  });

  test("an email invite posts the address, and the person is removed by it", async () => {
    signedInAs("owner");
    const writes = servePeople();
    renderApp("/people");
    await screen.findByText("@kai-dev");
    await userEvent.type(
      screen.getByLabelText("GitHub username or email"),
      "Sam@Studio.example",
    );
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    const sam = await screen.findByText("sam@studio.example");
    expect(sam).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove sam@studio.example" }),
    );
    await userEvent.click(
      row("sam@studio.example").getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(sam).not.toBeInTheDocument());
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/web/people",
        body: { username: "sam@studio.example", projectKeys: [] },
      },
      {
        method: "DELETE",
        path: "/api/web/people/sam%40studio.example",
        body: null,
      },
    ]);
  });
});
