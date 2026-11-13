import type {
  EntryView,
  PersonView,
  WebActorView,
  WebIssueListView,
  WebIssueRowView,
  WebIssueView,
  WebProjectView,
  WebStatusUpdateView,
} from "@/lib/api-types";

/** A photo URL in the server's real shape: `/api/photos/<actorId>/<64 lowercase hex>`. */
export const photoUrlFor = (actorId: string, hexByte: string) =>
  `/api/photos/${actorId}/${hexByte.repeat(32)}`;

export const kai: WebActorView = {
  id: "a-kai",
  name: "Kai",
  kind: "bot",
  photoUrl: null,
};
/** Kai with a photo on file. */
export const kaiWithPhoto: WebActorView = {
  ...kai,
  photoUrl: photoUrlFor("a-kai", "3f"),
};
export const maya: WebActorView = {
  id: "a-maya",
  name: "Maya Chen",
  kind: "human",
  photoUrl: null,
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
    actor: kai,
    project: trail,
    issue: { key: "TRL-14", title: "Team access: invite people" },
    comment: {
      id: `c-${id}`,
      body: "Owner-only invite is right.",
      sourceAuthor: null,
    },
    ...overrides,
  };
}

export function statusEntry(id: string, createdAt: string): EntryView {
  return {
    kind: "status_changed",
    id,
    createdAt,
    actor: kai,
    project: trail,
    issue: { key: "TRL-12", title: "Stream the feed over SSE" },
    from: "in_progress",
    to: "done",
  };
}

export const tara: WebActorView = {
  id: "a-tara",
  name: "Tara",
  kind: "bot",
  photoUrl: null,
};

export function statusUpdate(
  overrides: Partial<WebStatusUpdateView> = {},
): WebStatusUpdateView {
  return {
    id: "su-1",
    body: "SSE feed shipped. Human UI design is in review.",
    health: "on_track",
    author: tara,
    sourceAuthor: null,
    createdAt: "2026-11-11T09:12:00.000Z",
    ...overrides,
  };
}

export function project(
  overrides: Partial<WebProjectView> = {},
): WebProjectView {
  return {
    ...trail,
    description: "Agent-first issue tracker",
    health: "on_track",
    latestStatusUpdate: statusUpdate(),
    openCount: 9,
    inProgressCount: 3,
    updatedAt: "2026-11-11T09:12:00.000Z",
    ...overrides,
  };
}

export function issueRow(
  overrides: Partial<WebIssueRowView> = {},
): WebIssueRowView {
  return {
    key: "TRL-17",
    title: "Human UI: feed, projects, issue page",
    status: "open",
    priority: 2,
    labels: ["ui", "design"],
    assignee: tara,
    updatedAt: "2026-11-11T11:00:00.000Z",
    ...overrides,
  };
}

export function issueList(
  items: WebIssueRowView[],
  counts: Partial<WebIssueListView["counts"]> = {},
): WebIssueListView {
  return {
    items,
    nextCursor: null,
    counts: {
      all: 38,
      open: 9,
      in_progress: 3,
      done: 24,
      canceled: 2,
      ...counts,
    },
  };
}

export function issue(overrides: Partial<WebIssueView> = {}): WebIssueView {
  const on = { project: trail, issue: { key: "TRL-14", title: "Team access" } };
  return {
    key: "TRL-14",
    sourceKey: null,
    project: trail,
    title: "Team access: invite people by GitHub username",
    description: "Invited people sign in with GitHub.",
    status: "in_progress",
    priority: 2,
    estimate: 6,
    labels: ["auth", "ui"],
    links: [
      {
        url: "https://github.com/ap-justin/trail/pull/31",
        title: "Add project_member table and invite API #31",
      },
    ],
    assignee: kai,
    creator: tara,
    sourceAuthor: null,
    createdAt: "2026-11-09T14:02:00.000Z",
    updatedAt: "2026-11-11T09:44:00.000Z",
    completedAt: null,
    timeline: [
      {
        ...on,
        kind: "issue_created",
        id: "t1",
        createdAt: "2026-11-09T14:02:00.000Z",
        actor: tara,
        sourceAuthor: null,
      },
      {
        ...on,
        kind: "priority_changed",
        id: "t2",
        createdAt: "2026-11-09T14:05:00.000Z",
        actor: kai,
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
        actor: kai,
        from: "open",
        to: "in_progress",
      },
    ],
    ...overrides,
  };
}

export const people: PersonView[] = [
  {
    username: "justinsalas",
    email: null,
    owner: true,
    pending: false,
    name: "Justin Salas",
    photoUrl: null,
    projects: [],
    invitedAt: null,
  },
  {
    username: "mayachen",
    email: null,
    owner: false,
    pending: false,
    name: "Maya Chen",
    photoUrl: null,
    projects: [trail, { key: "DOC", name: "Docs site" }],
    invitedAt: "2026-11-09T10:00:00.000Z",
  },
  {
    username: "kai-dev",
    email: null,
    owner: false,
    pending: true,
    name: null,
    photoUrl: null,
    projects: [{ key: "OPB", name: "OpenBot" }],
    invitedAt: "2026-11-10T10:00:00.000Z",
  },
];

export const allProjects = [
  trail,
  { key: "OPB", name: "OpenBot" },
  { key: "DOC", name: "Docs site" },
];
