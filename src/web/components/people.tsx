import { Trash2Icon, UserIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ActorAvatar } from "@/components/actor";
import { ErrorState, ListSkeleton } from "@/components/states";
import { KeyText } from "@/components/text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { PersonView, WebProjectRefView } from "@/lib/api-types";
import { cn } from "@/lib/utils";

export type Invite = { username: string; projectKeys: string[] };

/** A save or remove on one person's row, reported at that row's control. */
export type RowMutation = {
  username: string;
  action: "save" | "remove";
  pending: boolean;
  /** Why it failed, shown on the row; null when it didn't. */
  error: ReactNode;
};

export type PeopleViewProps = {
  status: "loading" | "error" | "ready";
  /** The owner's row first, then everyone invited. */
  people: PersonView[];
  /** Every project the owner can give access to. */
  projects: WebProjectRefView[];
  onRetry: () => void;
  /** The username arrives lowercased, without the @; an empty project list is allowed. */
  onInvite: (invite: Invite) => void;
  invitePending: boolean;
  /** Why the last invite failed, under the invite row; null when it didn't. */
  inviteError: ReactNode;
  onSaveProjects: (username: string, projectKeys: string[]) => void;
  onRemove: (username: string) => void;
  /** One entry per row with a save or remove in flight or just failed, matched by username. */
  rowMutations: RowMutation[];
};

// GitHub's rule, as `githubUsername` in src/shared/schemas.ts: 1-39 of a-z, 0-9 and single inner hyphens
const githubUsername = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Trims, drops a leading @ and lowercases, then checks; returns the username or the message. */
export function parseUsername(
  raw: string,
): { username: string } | { error: string } {
  const username = raw.trim().replace(/^@/, "").toLowerCase();
  if (!username) return { error: "Add a GitHub username." };
  if (!githubUsername.test(username)) {
    return {
      error: "Use letters, digits and single hyphens, up to 39 characters.",
    };
  }
  return { username };
}

const displayName = (person: PersonView) =>
  person.name ?? `@${person.username}`;

function PersonAvatar({ person }: { person: PersonView }) {
  if (!person.pending) {
    return (
      <ActorAvatar
        actor={{
          name: person.name ?? "",
          kind: "human",
          photoUrl: person.photoUrl,
        }}
        size="md"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed text-2xs font-semibold text-muted-foreground"
    >
      ?
    </span>
  );
}

function ProjectChip({
  project,
  keyOnly = false,
}: {
  project: WebProjectRefView;
  keyOnly?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className="h-5.5 gap-1.5 rounded-md px-2 text-xs font-normal"
    >
      <KeyText className="text-current">{project.key}</KeyText>{" "}
      {!keyOnly && project.name}
    </Badge>
  );
}

/** One checkbox per project, each inside its own label. */
function ProjectChecklist({
  projects,
  selected,
  onChange,
  firstRef,
  className,
}: {
  projects: WebProjectRefView[];
  selected: string[];
  onChange: (keys: string[]) => void;
  firstRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      {projects.map((project, index) => {
        const checked = selected.includes(project.key);
        return (
          // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's Checkbox renders the input this label wraps
          <label
            key={project.key}
            className="flex min-h-10 cursor-pointer items-center gap-2 lg:min-h-7"
          >
            <Checkbox
              ref={index === 0 ? firstRef : undefined}
              checked={checked}
              onCheckedChange={(next) =>
                onChange(
                  next
                    ? [...selected, project.key]
                    : selected.filter((key) => key !== project.key),
                )
              }
            />
            <KeyText className="text-foreground">{project.key}</KeyText>{" "}
            {project.name}
          </label>
        );
      })}
    </div>
  );
}

function ProjectPicker({
  projects,
  selected,
  onChange,
}: {
  projects: WebProjectRefView[];
  selected: string[];
  onChange: (keys: string[]) => void;
}) {
  const picked = projects.filter((p) => selected.includes(p.key));
  return (
    <Popover>
      <PopoverTrigger className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border border-input px-1.5 lg:flex-1 text-left outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 max-lg:h-10 dark:bg-input/30">
        <span className="sr-only">Projects:</span>
        {picked.map((project) => (
          <ProjectChip key={project.key} project={project} keyOnly />
        ))}
        {picked.length === 0 && (
          <span className="truncate px-1 text-muted-foreground lg:ml-auto">
            Pick projects
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <ProjectChecklist
          projects={projects}
          selected={selected}
          onChange={onChange}
        />
      </PopoverContent>
    </Popover>
  );
}

function InviteForm({
  projects,
  onInvite,
  pending,
  error,
}: {
  projects: WebProjectRefView[];
  onInvite: (invite: Invite) => void;
  pending: boolean;
  error: ReactNode;
}) {
  const [username, setUsername] = useState("");
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  // null until the first submit; from then on each edit re-checks
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // the failure answered the username as submitted, so editing it retires the message
  const [editedSinceInvite, setEditedSinceInvite] = useState(false);
  const [wasPending, setWasPending] = useState(pending);
  if (pending !== wasPending) {
    setWasPending(pending);
    // the invite landed and its row is in the list, so the form starts over
    if (!pending && !error) {
      setUsername("");
      setProjectKeys([]);
      setSubmitted(false);
      setUsernameError(null);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = {
    heading: useId(),
    username: useId(),
    error: useId(),
    hint: useId(),
    status: useId(),
  };

  const check = (value: string) => {
    const parsed = parseUsername(value);
    return "error" in parsed ? parsed.error : null;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setSubmitted(true);
    const parsed = parseUsername(username);
    if ("error" in parsed) {
      setUsernameError(parsed.error);
      inputRef.current?.focus();
      return;
    }
    setUsernameError(null);
    setEditedSinceInvite(false);
    onInvite({ username: parsed.username, projectKeys });
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={ids.heading}
      className="flex flex-col gap-1.5"
    >
      <h2 id={ids.heading} className="mb-0.5 font-medium max-lg:sr-only">
        Invite someone
      </h2>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
        <div className="flex flex-col gap-1 lg:w-60">
          <label htmlFor={ids.username} className="sr-only">
            GitHub username
          </label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
            >
              @
            </span>
            <Input
              id={ids.username}
              ref={inputRef}
              value={username}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setUsername(next);
                setEditedSinceInvite(true);
                if (submitted) setUsernameError(check(next));
              }}
              aria-invalid={usernameError ? true : undefined}
              aria-describedby={
                usernameError ? `${ids.error} ${ids.hint}` : ids.hint
              }
              className="pl-6 max-lg:h-10"
            />
          </div>
          {usernameError && (
            <p id={ids.error} className="text-xs text-destructive">
              {usernameError}
            </p>
          )}
        </div>
        <ProjectPicker
          projects={projects}
          selected={projectKeys}
          onChange={setProjectKeys}
        />
        <Button
          type="submit"
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          className="max-lg:h-10 lg:px-3"
        >
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </div>
      <p id={ids.hint} className="text-xs text-muted-foreground">
        They sign in with GitHub and see only the projects you pick.
      </p>
      <p id={ids.status} role="status" className="text-xs text-destructive">
        {editedSinceInvite ? null : error}
      </p>
    </form>
  );
}

type Mode = "view" | "edit" | "confirm";

/**
 * A row's failure line, mounted with the controls so the first failure is announced.
 * Empty, it leaves the flow: an empty item would still take a gap.
 */
function RowStatus({
  error,
  className,
}: {
  error: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      className={cn("text-xs text-destructive empty:absolute", className)}
    >
      {error}
    </p>
  );
}

function PersonRow({
  person,
  projects,
  onSaveProjects,
  onRemove,
  mutation,
}: {
  person: PersonView;
  projects: WebProjectRefView[];
  onSaveProjects: (username: string, projectKeys: string[]) => void;
  onRemove: (username: string) => void;
  mutation: RowMutation | null;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<string[]>([]);
  // the write this row sent and still owes an outcome for
  const [sent, setSent] = useState<RowMutation["action"] | null>(null);
  const busy = mutation?.pending ?? false;
  const saving = busy && mutation?.action === "save";
  const removing = busy && mutation?.action === "remove";
  const [wasSaving, setWasSaving] = useState(saving);
  if (saving !== wasSaving) {
    setWasSaving(saving);
    // a save landed: the row shows the saved projects again
    if (!saving && !mutation?.error) {
      setSent(null);
      if (mode === "edit") setMode("view");
    }
  }
  const failure =
    mutation && !mutation.pending && mutation.action === sent
      ? mutation.error
      : null;

  // a settled outcome stays with the panel it answered; a write still running reports wherever the row goes
  const changeMode = (next: Mode) => {
    if (!busy) setSent(null);
    setMode(next);
  };
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    changeMode("view");
  };

  const editRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const firstCheckboxRef = useRef<HTMLButtonElement>(null);
  const previousMode = useRef<Mode>(mode);
  useEffect(() => {
    const from = previousMode.current;
    previousMode.current = mode;
    if (from === mode) return;
    // the element that held focus was swapped out, so focus follows the mode change
    if (mode === "edit") firstCheckboxRef.current?.focus();
    else if (mode === "confirm") keepRef.current?.focus();
    else if (from === "edit") editRef.current?.focus();
    else removeRef.current?.focus();
  }, [mode]);

  const name = displayName(person);
  const handle = `@${person.username}`;
  const firstName = person.name?.split(/\s+/)[0] ?? handle;
  const editing = mode === "edit";

  return (
    <li
      data-username={person.username}
      className={cn(
        "flex flex-col gap-2 border-b px-4 py-3 lg:flex-row lg:flex-wrap lg:items-center lg:gap-3 lg:px-2",
        editing && "lg:my-1.5 lg:rounded-xl lg:border lg:bg-muted",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 lg:w-58 lg:gap-3">
        <PersonAvatar person={person} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{name}</span>
            {person.owner && (
              <Badge
                variant="outline"
                className="h-4.5 gap-0.75 rounded-sm px-1.5 text-2xs text-muted-foreground"
              >
                <UserIcon data-icon="inline-start" aria-hidden="true" />
                Owner
              </Badge>
            )}
          </span>
          <span className="truncate text-muted-foreground">
            {person.pending ? (
              "Invited · hasn't signed in"
            ) : (
              <>
                {person.name && handle}
                {person.owner && (
                  <span className="lg:hidden"> · All projects</span>
                )}
              </>
            )}
          </span>
        </div>
      </div>

      {person.owner ? (
        <span className="text-muted-foreground max-lg:hidden">
          All projects
        </span>
      ) : editing ? (
        <form
          className="flex flex-col gap-2 lg:basis-full lg:pl-60"
          onKeyDown={cancelOnEscape}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setSent("save");
            onSaveProjects(person.username, draft);
          }}
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-muted-foreground">
              Choose the projects {firstName} can see
            </legend>
            <ProjectChecklist
              projects={projects}
              selected={draft}
              onChange={setDraft}
              firstRef={firstCheckboxRef}
            />
          </fieldset>
          <RowStatus error={failure} />
          <div className="flex gap-2 pt-1">
            <Button
              type="submit"
              size="sm"
              aria-disabled={busy || undefined}
              aria-busy={saving || undefined}
              className="max-lg:h-10 max-lg:flex-1"
            >
              {saving ? "Saving…" : "Save projects"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-lg:h-10 max-lg:flex-1"
              onClick={() => changeMode("view")}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {person.projects.map((project) => (
              <ProjectChip key={project.key} project={project} />
            ))}
          </div>
          {mode === "confirm" ? (
            <fieldset
              aria-label={`Remove ${handle}`}
              className="flex min-w-0 flex-wrap items-center gap-2 lg:gap-3"
              onKeyDown={cancelOnEscape}
            >
              <span className="text-muted-foreground max-lg:basis-full">
                Remove {handle}?
              </span>
              <Button
                ref={keepRef}
                variant="outline"
                size="sm"
                className="max-lg:h-10 max-lg:flex-1"
                onClick={() => changeMode("view")}
              >
                Keep
              </Button>
              <Button
                variant="destructive"
                size="sm"
                aria-disabled={busy || undefined}
                aria-busy={removing || undefined}
                className="max-lg:h-10 max-lg:flex-1"
                onClick={() => {
                  if (busy) return;
                  setSent("remove");
                  onRemove(person.username);
                }}
              >
                {removing ? "Removing…" : "Remove"}
              </Button>
              <RowStatus error={failure} className="basis-full" />
            </fieldset>
          ) : (
            <div className="flex gap-2">
              <Button
                ref={editRef}
                data-row-action="edit"
                variant="outline"
                size="sm"
                aria-label={`Edit projects for ${handle}`}
                className="max-lg:h-10 max-lg:flex-1"
                onClick={() => {
                  setDraft(person.projects.map((p) => p.key));
                  changeMode("edit");
                }}
              >
                Edit projects
              </Button>
              <Button
                ref={removeRef}
                variant="outline"
                size="sm"
                aria-label={`Remove ${handle}`}
                className="text-destructive max-lg:h-10 max-lg:flex-1"
                onClick={() => changeMode("confirm")}
              >
                <Trash2Icon data-icon="inline-start" aria-hidden="true" />
                Remove
              </Button>
            </div>
          )}
          {mode === "view" && sent && (
            <RowStatus error={failure} className="lg:basis-full lg:pl-60" />
          )}
        </>
      )}
    </li>
  );
}

/**
 * The owner's People page: invite by GitHub username with the projects they may see,
 * then everyone with access. The owner's row has no actions.
 */
export function PeopleView(props: PeopleViewProps) {
  const listHeading = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shownPeople = useRef(props.people);
  useEffect(() => {
    const before = shownPeople.current;
    shownPeople.current = props.people;
    // a removed row took its focused Remove button with it; anything else keeps focus where it is
    if (document.activeElement !== document.body) return;
    const now = new Set(props.people.map((p) => p.username));
    const goneAt = before.findIndex((p) => !now.has(p.username));
    if (goneAt === -1) return;
    const next = before.slice(goneAt + 1).find((p) => now.has(p.username));
    const nextEdit =
      next &&
      listRef.current?.querySelector<HTMLButtonElement>(
        `[data-username="${next.username}"] [data-row-action="edit"]`,
      );
    (nextEdit ?? headingRef.current)?.focus();
  }, [props.people]);
  return (
    <div className="mx-auto flex w-full max-w-220 flex-col gap-6 pt-3 lg:px-6 lg:py-6">
      <div className="px-4 lg:px-0">
        <InviteForm
          projects={props.projects}
          onInvite={props.onInvite}
          pending={props.invitePending}
          error={props.inviteError}
        />
      </div>
      <section aria-labelledby={listHeading}>
        <h2
          id={listHeading}
          ref={headingRef}
          tabIndex={-1}
          className="mb-1 font-medium outline-none max-lg:sr-only"
        >
          People
          {props.status === "ready" && (
            <span className="ml-1 font-normal text-muted-foreground">
              {props.people.length}
            </span>
          )}
        </h2>
        {props.status === "loading" && (
          <ListSkeleton className="px-4 lg:px-0" />
        )}
        {props.status === "error" && (
          <ErrorState
            title="Couldn't load people"
            description="Check your connection, then try again."
            onRetry={props.onRetry}
          />
        )}
        {props.status === "ready" && (
          <ul ref={listRef} className="border-t">
            {props.people.map((person) => (
              <PersonRow
                key={person.username}
                person={person}
                projects={props.projects}
                onSaveProjects={props.onSaveProjects}
                onRemove={props.onRemove}
                mutation={
                  props.rowMutations.find(
                    (write) => write.username === person.username,
                  ) ?? null
                }
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
