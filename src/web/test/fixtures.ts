import type {
  EntryView,
  PersonView,
  WebActorView,
  WebConversationView,
  WebItemListView,
  WebItemRefView,
  WebItemRowView,
  WebItemView,
  WebMessageView,
  WebProductDetailView,
  WebProductView,
  WebProjectDetailView,
  WebProjectItemsView,
  WebProjectView,
  WebStatusCountsView,
  WebStatusUpdateView,
} from "@/lib/api-types";

/** A photo URL in the server's real shape: `/api/photos/<actorId>/<64 lowercase hex>`. */
export const photoUrlFor = (actorId: string, hexByte: string) =>
  `/api/photos/${actorId}/${hexByte.repeat(32)}`;

export const alpha: WebActorView = {
  id: "a-alpha",
  name: "Alpha",
  kind: "bot",
  photoUrl: null,
  title: null,
};
/** Alpha with a photo on file. */
export const alphaWithPhoto: WebActorView = {
  ...alpha,
  photoUrl: photoUrlFor("a-alpha", "3f"),
};
export const maya: WebActorView = {
  id: "a-maya",
  name: "Maya Chen",
  kind: "human",
  photoUrl: null,
  title: null,
};

export const trail = { key: "TRL", name: "trail" };

export function commentEntry(
  id: string,
  createdAt: string,
  overrides: Partial<Extract<EntryView, { kind: "comment" }>> = {},
): EntryView {
  return {
    kind: "comment",
    id,
    createdAt,
    actor: alpha,
    product: trail,
    project: null,
    item: { key: "TRL-14", title: "Team access: invite people", type: "issue" },
    comment: {
      id: `c-${id}`,
      body: "Owner-only invite is right.",
      sourceAuthor: null,
    },
    ...overrides,
  };
}

export function statusEntry(
  id: string,
  createdAt: string,
  change: Pick<
    Extract<EntryView, { kind: "status_changed" }>,
    "from" | "to"
  > = { from: "in_progress", to: "done" },
): EntryView {
  return {
    kind: "status_changed",
    id,
    createdAt,
    actor: alpha,
    product: trail,
    project: null,
    item: { key: "TRL-12", title: "Stream the feed over SSE", type: "issue" },
    ...change,
  };
}

export function projectImportedEntry(
  id: string,
  createdAt: string,
  imported: { issues: number; comments: number },
): EntryView {
  return {
    kind: "product_imported",
    id,
    createdAt,
    actor: alpha,
    product: trail,
    project: null,
    item: null,
    imported,
  };
}

export const beta: WebActorView = {
  id: "a-beta",
  name: "Beta",
  kind: "bot",
  photoUrl: null,
  title: null,
};

export function statusUpdate(
  overrides: Partial<WebStatusUpdateView> = {},
): WebStatusUpdateView {
  return {
    id: "su-1",
    body: "SSE feed shipped. Human UI design is in review.",
    health: "on_track",
    author: beta,
    sourceAuthor: null,
    createdAt: "2026-11-11T09:12:00.000Z",
    ...overrides,
  };
}

/** TRL as a row on the products list. */
export function product(
  overrides: Partial<WebProductView> = {},
): WebProductView {
  return {
    ...trail,
    description: "Agent-first issue tracker",
    repoUrl: null,
    health: "on_track",
    latestStatusUpdate: statusUpdate(),
    openIssues: 7,
    openTodos: 2,
    projectCount: 0,
    updatedAt: "2026-11-11T09:12:00.000Z",
    ...overrides,
  };
}

export function issueRow(
  overrides: Partial<WebItemRowView> = {},
): WebItemRowView {
  return {
    key: "TRL-17",
    type: "issue",
    title: "Human UI: feed, projects, issue page",
    status: "open",
    priority: 2,
    labels: ["ui", "design"],
    assignee: beta,
    updatedAt: "2026-11-11T11:00:00.000Z",
    ...overrides,
  };
}

export function issueList(
  items: WebItemRowView[],
  counts: Partial<WebItemListView["counts"]["all"]> = {},
): WebItemListView {
  const all = {
    all: 38,
    open: 9,
    in_progress: 3,
    done: 24,
    canceled: 2,
    ...counts,
  };
  const none = { all: 0, open: 0, in_progress: 0, done: 0, canceled: 0 };
  return {
    items,
    nextCursor: null,
    counts: {
      all,
      issue: all,
      todo: none,
      notes: { current: 0, archived: 0 },
    },
  };
}

export function issue(overrides: Partial<WebItemView> = {}): WebItemView {
  const on = {
    product: trail,
    project: null,
    item: { key: "TRL-14", title: "Team access", type: "issue" as const },
  };
  return {
    key: "TRL-14",
    type: "issue",
    sourceKey: null,
    product: trail,
    projects: [],
    title: "Team access: invite people by GitHub username",
    description: "Invited people sign in with GitHub.",
    status: "in_progress",
    priority: 2,
    estimate: 6,
    labels: ["auth", "ui"],
    links: [
      {
        url: "https://github.com/example/trail/pull/31",
        title: "Add project_member table and invite API #31",
      },
    ],
    assignee: alpha,
    creator: beta,
    sourceAuthor: null,
    createdAt: "2026-11-09T14:02:00.000Z",
    updatedAt: "2026-11-11T09:44:00.000Z",
    completedAt: null,
    about: [],
    notes: [],
    timeline: [
      {
        ...on,
        kind: "item_created",
        id: "t1",
        createdAt: "2026-11-09T14:02:00.000Z",
        actor: beta,
        sourceAuthor: null,
        createdAs: "issue",
      },
      {
        ...on,
        kind: "priority_changed",
        id: "t2",
        createdAt: "2026-11-09T14:05:00.000Z",
        actor: alpha,
        from: 0,
        to: 2,
      },
      {
        ...on,
        kind: "comment",
        id: "t3",
        createdAt: "2026-11-10T17:12:00.000Z",
        actor: maya,
        comment: {
          id: "c1",
          body: "Owner only for invites.",
          sourceAuthor: null,
        },
      },
      {
        ...on,
        kind: "status_changed",
        id: "t4",
        createdAt: "2026-11-11T09:44:00.000Z",
        actor: alpha,
        from: "open",
        to: "in_progress",
      },
    ],
    ...overrides,
  };
}

export const people: PersonView[] = [
  {
    username: "jordansmith",
    email: null,
    owner: true,
    pending: false,
    name: "Jordan Smith",
    photoUrl: null,
    products: [],
    invitedAt: null,
  },
  {
    username: "mayachen",
    email: null,
    owner: false,
    pending: false,
    name: "Maya Chen",
    photoUrl: null,
    products: [trail, { key: "DOC", name: "Docs site" }],
    invitedAt: "2026-11-09T10:00:00.000Z",
  },
  {
    username: "alpha-dev",
    email: null,
    owner: false,
    pending: true,
    name: null,
    photoUrl: null,
    products: [{ key: "OPB", name: "OpenBot" }],
    invitedAt: "2026-11-10T10:00:00.000Z",
  },
];

export const allProducts = [
  trail,
  { key: "OPB", name: "OpenBot" },
  { key: "DOC", name: "Docs site" },
];

export const humanUi = { slug: "human-ui", name: "Human UI launch" };
export const teamAccess = { slug: "team-access", name: "Team access" };

/** TRL-15, a todo Alpha planned and owns, in the Human UI launch project. */
export function todo(overrides: Partial<WebItemView> = {}): WebItemView {
  const on = {
    product: trail,
    project: null,
    item: { key: "TRL-15", title: "Back up the volume", type: "todo" as const },
  };
  return issue({
    key: "TRL-15",
    type: "todo",
    projects: [humanUi],
    title: "Back up the volume with Litestream",
    description: "Stream the SQLite WAL off the Fly volume.",
    labels: ["infra"],
    links: [],
    assignee: alpha,
    creator: alpha,
    timeline: [
      {
        ...on,
        kind: "item_created",
        id: "t1",
        createdAt: "2026-11-11T10:15:00.000Z",
        actor: alpha,
        sourceAuthor: null,
        createdAs: "todo",
      },
      {
        ...on,
        project: humanUi,
        kind: "added_to_project",
        id: "t2",
        createdAt: "2026-11-11T10:16:00.000Z",
        actor: alpha,
      },
    ],
    ...overrides,
  });
}

/** TRL-31, a current note Alpha wrote about TRL-14 and TRL-15. */
export function note(overrides: Partial<WebItemView> = {}): WebItemView {
  const on = {
    product: trail,
    project: null,
    item: {
      key: "TRL-31",
      title: "Why the feed reads newest first",
      type: "note" as const,
    },
  };
  return issue({
    key: "TRL-31",
    type: "note",
    title: "Why the feed reads newest first",
    description: "People open the feed to see what just happened.",
    status: "current",
    priority: 0,
    estimate: null,
    labels: [],
    links: [],
    assignee: null,
    creator: alpha,
    about: [
      {
        key: "TRL-14",
        title: "Team access",
        type: "issue",
        status: "in_progress",
      },
      {
        key: "TRL-15",
        title: "Back up the volume with Litestream",
        type: "todo",
        status: "open",
      },
    ],
    timeline: [
      {
        ...on,
        kind: "item_created",
        id: "t1",
        createdAt: "2026-11-11T10:20:00.000Z",
        actor: alpha,
        sourceAuthor: null,
        createdAs: "note",
      },
    ],
    ...overrides,
  });
}

type Item = WebItemRefView;
const teamAccessIssue: Item = {
  key: "TRL-14",
  title: "Team access: invite people",
  type: "issue",
};

export function itemCreatedEntry(
  id: string,
  createdAt: string,
  {
    actor = alpha,
    item = teamAccessIssue,
    createdAs = item.type,
  }: { actor?: WebActorView; item?: Item; createdAs?: Item["type"] } = {},
): EntryView {
  return {
    kind: "item_created",
    id,
    createdAt,
    actor,
    product: trail,
    project: null,
    item,
    sourceAuthor: null,
    createdAs,
  };
}

export function typeChangedEntry(id: string, createdAt: string): EntryView {
  return {
    kind: "type_changed",
    id,
    createdAt,
    actor: alpha,
    product: trail,
    project: null,
    item: { ...teamAccessIssue, type: "todo" },
    from: "issue",
    to: "todo",
  };
}

export function membershipEntry(
  id: string,
  createdAt: string,
  kind: "added_to_project" | "removed_from_project",
): EntryView {
  return {
    kind,
    id,
    createdAt,
    actor: alpha,
    product: trail,
    project: humanUi,
    item: teamAccessIssue,
  };
}

export function productStatusUpdateEntry(
  id: string,
  createdAt: string,
): EntryView {
  return {
    kind: "product_status_update",
    id,
    createdAt,
    actor: alpha,
    product: { key: "OPB", name: "OpenBot" },
    project: null,
    item: null,
    statusUpdate: {
      id: "su-p",
      body: "Webhook retries stall after a 502.",
      health: "at_risk",
      sourceAuthor: null,
    },
  };
}

export function projectStatusUpdateEntry(
  id: string,
  createdAt: string,
): EntryView {
  return {
    kind: "project_status_update",
    id,
    createdAt,
    actor: alpha,
    product: null,
    project: humanUi,
    item: null,
    statusUpdate: {
      id: "su-j",
      body: "Feed and product pages are drawn.",
      health: "at_risk",
      sourceAuthor: null,
    },
  };
}

export function projectEntry(
  id: string,
  createdAt: string,
  kind: "project_created" | "project_updated",
): EntryView {
  const base = {
    id,
    createdAt,
    actor: alpha,
    product: null,
    project: humanUi,
    item: null,
  };
  return kind === "project_created"
    ? { ...base, kind }
    : { ...base, kind, changed: ["goal", "targetDate"] };
}

/** A third bot, with a title; leads the Human UI launch project and is the third party in conversations. */
export const gamma: WebActorView = {
  id: "a-gamma",
  name: "Gamma",
  kind: "bot",
  photoUrl: null,
  title: "Release engineer",
};
export const openBot = { key: "OPB", name: "OpenBot" };
export const docsSite = { key: "DOC", name: "Docs site" };

/** TRL-22, a todo Beta owns. */
export function todoRow(
  overrides: Partial<WebItemRowView> = {},
): WebItemRowView {
  return issueRow({
    key: "TRL-22",
    type: "todo",
    title: "Split Projects into Products and Projects in the nav",
    priority: 3,
    labels: ["ui"],
    updatedAt: "2026-11-11T11:52:00.000Z",
    ...overrides,
  });
}

/** TRL-31, a current note Alpha wrote. */
export function noteRow(
  overrides: Partial<WebItemRowView> = {},
): WebItemRowView {
  return issueRow({
    key: "TRL-31",
    type: "note",
    title: "Why the feed reads newest first",
    status: "current",
    priority: 0,
    labels: [],
    assignee: null,
    updatedAt: "2026-11-11T10:20:00.000Z",
    ...overrides,
  });
}

const tally = (items: WebItemRowView[]): WebStatusCountsView => {
  const of = (status: WebItemRowView["status"]) =>
    items.filter((i) => i.status === status).length;
  return {
    all: items.length,
    open: of("open") + of("triage"),
    in_progress: of("in_progress"),
    done: of("done"),
    canceled: of("canceled"),
  };
};

/** Counts per type and status tab, as the server tallies them, for exactly these rows: notes apart. */
export function countsOf(items: WebItemRowView[]) {
  const notes = items.filter((i) => i.type === "note");
  return {
    all: tally(items.filter((i) => i.type !== "note")),
    issue: tally(items.filter((i) => i.type === "issue")),
    todo: tally(items.filter((i) => i.type === "todo")),
    notes: {
      current: notes.filter((i) => i.status === "current").length,
      archived: notes.filter((i) => i.status === "archived").length,
    },
  };
}

/** A product's item list whose counts are these rows' own. */
export function itemList(items: WebItemRowView[]): WebItemListView {
  return { items, nextCursor: null, counts: countsOf(items) };
}

/** The Human UI launch project as a row on the projects list. */
export function projectRow(
  overrides: Partial<WebProjectView> = {},
): WebProjectView {
  return {
    ...humanUi,
    goal: "People read the team's work in trail without asking a bot",
    health: "at_risk",
    latestStatusUpdate: statusUpdate({
      id: "su-h",
      body: "Feed and product pages are drawn. Docs site pages wait on the new logo.",
      health: "at_risk",
      author: gamma,
    }),
    lead: gamma,
    targetDate: "2026-12-04",
    products: [docsSite, openBot, trail],
    openCount: 14,
    updatedAt: "2026-11-11T09:12:00.000Z",
    ...overrides,
  };
}

export function projectDetail(
  overrides: Partial<WebProjectDetailView> = {},
): WebProjectDetailView {
  return { ...projectRow(), hiddenProducts: false, ...overrides };
}

/** Team access: one product, Alpha leads, on track. */
export const teamAccessRow = (): WebProjectView =>
  projectRow({
    ...teamAccess,
    goal: "Invite people to the products they should see",
    health: "on_track",
    latestStatusUpdate: statusUpdate({ id: "su-t", author: alpha }),
    lead: alpha,
    targetDate: "2026-11-30",
    products: [trail],
    openCount: 5,
  });

/** TRL on its own page: a repo, an owner and two projects. */
export function productDetail(
  overrides: Partial<WebProductDetailView> = {},
): WebProductDetailView {
  return {
    ...product({
      repoUrl: "https://github.com/example/trail",
      projectCount: 2,
    }),
    owner: alpha,
    projects: [projectRow(), teamAccessRow()],
    ...overrides,
  };
}

/** A project's items in groups, each group's count its own rows'. */
export function projectItems(
  groups: { product: { key: string; name: string }; items: WebItemRowView[] }[],
): WebProjectItemsView {
  return {
    groups: groups.map((g) => ({ ...g, count: g.items.length })),
    nextCursor: null,
    counts: countsOf(groups.flatMap((g) => g.items)),
  };
}

/** Alpha and Beta's conversation as a row on the messages list; Beta sent the last message. */
export function conversation(
  overrides: Partial<WebConversationView> = {},
): WebConversationView {
  return {
    bots: [alpha, beta],
    lastMessage: {
      id: "m-3",
      senderId: beta.id,
      preview: "Deploy finished. The volume backup runs nightly now.",
      truncated: false,
      createdAt: "2026-11-11T09:40:00.000Z",
      expectsReply: true,
    },
    count: 3,
    lastAt: "2026-11-11T09:40:00.000Z",
    ...overrides,
  };
}

/** A message from Alpha to Beta that starts its thread and asks for a reply. */
export function message(
  overrides: Partial<WebMessageView> = {},
): WebMessageView {
  const id = overrides.id ?? "m-1";
  return {
    id,
    sender: alpha,
    recipient: beta,
    threadId: id,
    replyTo: null,
    text: "What's the **status** of the deploy?",
    expectsReply: true,
    createdAt: "2026-11-11T09:12:00.000Z",
    readAt: null,
    ...overrides,
  };
}
