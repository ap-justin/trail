import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ActorAvatar, avatarSizes } from "@/components/actor";
import { ErrorState, ListSkeleton } from "@/components/states";
import { KeyPill } from "@/components/text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { PersonView, WebProductRefView } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { INVITEE_HINT, parseInvitee } from "../../shared/invitee";

/** `username` is the server's field name; it holds a GitHub username or an email address. */
export type Invite = { username: string; productKeys: string[] };

/** Why the last invite failed. `atField` marks a refusal of the entry itself, such as already invited. */
export type InviteError = { message: string; atField: boolean };

/** A save or remove on one person's row, reported at that row's control. */
export type RowMutation = {
  /** The person's id, as `personId` gives it. */
  id: string;
  action: "save" | "remove";
  pending: boolean;
  /** Why it failed, shown on the row; null when it didn't. */
  error: ReactNode;
};

export type PeopleViewProps = {
  status: "loading" | "error" | "ready";
  /** The owner's row first, then everyone invited. */
  people: PersonView[];
  /** Every product the owner can give access to. */
  products: WebProductRefView[];
  onRetry: () => void;
  /** The entry arrives trimmed and lowercased, without a leading @; an empty product list is allowed. */
  onInvite: (invite: Invite) => void;
  invitePending: boolean;
  /** Why the last invite failed; null when it didn't. */
  inviteError: InviteError | null;
  /** Called with the person's id, as `personId` gives it. */
  onSaveProducts: (id: string, productKeys: string[]) => void;
  onRemove: (id: string) => void;
  /** One entry per row with a save or remove in flight or just failed, matched by id. */
  rowMutations: RowMutation[];
};

/**
 * A GitHub username or an email address, as `parseInvitee` reads it, after dropping the
 * @ someone may type before a username; null when it is neither.
 */
export function parseEntry(raw: string): string | null {
  const invitee = parseInvitee(raw.trim().replace(/^@/, ""));
  if (!invitee) return null;
  return "email" in invitee ? invitee.email : invitee.username;
}

/** The person's {username} in /people/{username}: the GitHub username, or the email of an email invite. */
export const personId = (person: PersonView) =>
  person.username ?? person.email ?? "";

/** What stands for the person where they have no name: @username, or their email address. */
const handleOf = (person: PersonView) =>
  person.username === null ? (person.email ?? "") : `@${person.username}`;

/** An address's part before the @, as initials: dana.okafor is DO, sam is SA. */
function emailInitials(email: string): string {
  const local = email.slice(0, email.indexOf("@"));
  const words = local.split(/[._+-]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : local.slice(0, 2);
  return letters.toUpperCase() || "?";
}

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
      className={cn(
        "grid shrink-0 place-items-center rounded-full border border-dashed font-semibold text-muted-foreground",
        avatarSizes.md,
      )}
    >
      {person.email === null ? "?" : emailInitials(person.email)}
    </span>
  );
}

function ProductChip({ product }: { product: WebProductRefView }) {
  return (
    <Badge variant="tag" data-product-chip>
      {`${product.name} `}
      <KeyPill>{product.key}</KeyPill>
    </Badge>
  );
}

/** One checkbox per product, each inside its own label. */
function ProductChecklist({
  products,
  selected,
  onChange,
  firstRef,
  className,
}: {
  products: WebProductRefView[];
  selected: string[];
  onChange: (keys: string[]) => void;
  firstRef?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      {products.map((product, index) => {
        const checked = selected.includes(product.key);
        return (
          // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's Checkbox renders the input this label wraps
          <label
            key={product.key}
            className="flex min-h-11 cursor-pointer items-center gap-2 lg:min-h-7"
          >
            <Checkbox
              ref={index === 0 ? firstRef : undefined}
              checked={checked}
              onCheckedChange={(next) =>
                onChange(
                  next
                    ? [...selected, product.key]
                    : selected.filter((key) => key !== product.key),
                )
              }
            />
            <span className="min-w-0 truncate">{product.name}</span>{" "}
            <KeyPill>{product.key}</KeyPill>
          </label>
        );
      })}
    </div>
  );
}

/** Named by its visible label, then what it holds: "Products they can see TRL trail". */
function ProductPicker({
  products,
  selected,
  onChange,
  labelId,
  className,
}: {
  products: WebProductRefView[];
  selected: string[];
  onChange: (keys: string[]) => void;
  labelId: string;
  className?: string;
}) {
  const picked = products.filter((p) => selected.includes(p.key));
  const valueId = useId();
  return (
    <Popover>
      <PopoverTrigger
        aria-labelledby={`${labelId} ${valueId}`}
        className={cn(
          "flex h-11 min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-input px-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:h-8 dark:bg-input/30",
          className,
        )}
      >
        <span id={valueId} className="contents">
          {picked.map((product) => (
            // the space keeps the chips apart in the button's name; flex drops it visually
            <Fragment key={product.key}>
              <ProductChip product={product} />{" "}
            </Fragment>
          ))}
          {picked.length === 0 && (
            <span className="truncate px-1 text-muted-foreground">
              Pick products
            </span>
          )}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="ml-auto size-4 shrink-0 text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <ProductChecklist
          products={products}
          selected={selected}
          onChange={onChange}
        />
      </PopoverContent>
    </Popover>
  );
}

function InviteForm({
  products,
  onInvite,
  pending,
  error,
}: {
  products: WebProductRefView[];
  onInvite: (invite: Invite) => void;
  pending: boolean;
  error: InviteError | null;
}) {
  const [username, setUsername] = useState("");
  const [productKeys, setProductKeys] = useState<string[]>([]);
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
      setProductKeys([]);
      setSubmitted(false);
      setUsernameError(null);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = {
    heading: useId(),
    username: useId(),
    products: useId(),
    error: useId(),
    hint: useId(),
    status: useId(),
  };

  const check = (value: string) =>
    parseEntry(value) === null ? INVITEE_HINT : null;
  const answered = editedSinceInvite ? null : error;
  // the server refused the entry itself, so the refusal sits at the field like the client's own
  const refusal = answered?.atField ? answered.message : null;
  const fieldError = usernameError ?? refusal;
  useEffect(() => {
    if (refusal) inputRef.current?.focus();
  }, [refusal]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setSubmitted(true);
    const entry = parseEntry(username);
    if (entry === null) {
      setUsernameError(INVITEE_HINT);
      inputRef.current?.focus();
      return;
    }
    setUsernameError(null);
    setEditedSinceInvite(false);
    onInvite({ username: entry, productKeys });
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby={ids.heading}
      className="flex flex-col gap-1.5"
    >
      <h2 id={ids.heading} className="sr-only">
        Invite someone
      </h2>
      {/* at lg labels over one row of controls; below, each label over its own control */}
      <div className="flex flex-col gap-1.5 lg:grid lg:grid-cols-[--spacing(80)_minmax(0,1fr)_auto] lg:gap-x-3">
        <label htmlFor={ids.username} className="font-medium max-lg:order-1">
          GitHub username or email
        </label>
        <span
          id={ids.products}
          className="font-medium max-lg:order-4 max-lg:mt-2.5 lg:col-span-2"
        >
          Products they can see
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
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? `${ids.error} ${ids.hint}` : ids.hint}
          className="max-lg:order-2"
        />
        <ProductPicker
          products={products}
          selected={productKeys}
          onChange={setProductKeys}
          labelId={ids.products}
          className="max-lg:order-5"
        />
        <Button
          type="submit"
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          className="max-lg:order-7 max-lg:mt-1 lg:px-3"
        >
          {pending ? "Inviting…" : "Invite"}
        </Button>
        {fieldError && (
          <p
            id={ids.error}
            className="text-xs text-destructive max-lg:order-3 lg:col-start-1"
          >
            {fieldError}
          </p>
        )}
        <p
          id={ids.hint}
          className="text-xs text-muted-foreground max-lg:order-6 lg:col-span-3 lg:mt-0.5 lg:max-w-160 lg:text-sm"
        >
          GitHub invitees sign in with GitHub; email invitees get a sign-in link
          by email. They see only the products you pick; a project shows them
          just the items from those products.
        </p>
      </div>
      <p id={ids.status} role="status" className="text-xs text-destructive">
        {answered && !answered.atField ? answered.message : null}
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
  products,
  onSaveProducts,
  onRemove,
  mutation,
}: {
  person: PersonView;
  products: WebProductRefView[];
  onSaveProducts: (id: string, productKeys: string[]) => void;
  onRemove: (id: string) => void;
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
    // a save landed: the row shows the saved products again
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

  const handle = handleOf(person);
  const name = person.name ?? handle;
  const firstName = person.name?.split(/\s+/)[0] ?? handle;
  const editing = mode === "edit";

  return (
    <li
      data-person={personId(person)}
      className={cn(
        "flex flex-col gap-2 border-b border-rule py-3 max-lg:mx-4 lg:min-h-14 lg:flex-row lg:flex-wrap lg:items-center lg:gap-3 lg:px-2 lg:py-2",
        editing && "lg:my-1.5 lg:rounded-xl lg:border lg:bg-muted lg:py-3",
      )}
    >
      {/* below lg the lines under this one indent past the avatar: 28px and its 12px gap */}
      <div className="flex min-w-0 items-center gap-3 lg:w-58">
        <PersonAvatar person={person} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{name}</span>
            {person.owner && (
              <span className="text-muted-foreground">Owner</span>
            )}
          </span>
          <span className="truncate text-muted-foreground">
            {person.pending
              ? "Invited, hasn't signed in"
              : person.name && (
                  <span className="font-mono text-xs">{handle}</span>
                )}
          </span>
        </div>
      </div>

      {person.owner ? (
        <span className="text-muted-foreground max-lg:pl-10">All products</span>
      ) : editing ? (
        <form
          className="flex flex-col gap-2 lg:basis-full lg:pl-60"
          onKeyDown={cancelOnEscape}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setSent("save");
            onSaveProducts(personId(person), draft);
          }}
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-muted-foreground">
              Choose the products {firstName} can see
            </legend>
            <ProductChecklist
              products={products}
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
              className="max-lg:flex-1"
            >
              {saving ? "Saving…" : "Save products"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-lg:flex-1"
              onClick={() => changeMode("view")}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1 max-lg:pl-10">
            {person.products.map((product) => (
              <ProductChip key={product.key} product={product} />
            ))}
          </div>
          {mode === "confirm" ? (
            <fieldset
              aria-label={`Remove ${handle}`}
              className="flex min-w-0 flex-wrap items-center gap-2 max-lg:pl-10 lg:gap-3"
              onKeyDown={cancelOnEscape}
            >
              <span className="text-muted-foreground max-lg:basis-full">
                Remove <span className="font-mono">{handle}</span>?
              </span>
              <Button
                ref={keepRef}
                variant="outline"
                onClick={() => changeMode("view")}
              >
                Keep
              </Button>
              <Button
                variant="destructive"
                aria-disabled={busy || undefined}
                aria-busy={removing || undefined}
                onClick={() => {
                  if (busy) return;
                  setSent("remove");
                  onRemove(personId(person));
                }}
              >
                {removing ? "Removing…" : "Remove"}
              </Button>
              <RowStatus error={failure} className="basis-full" />
            </fieldset>
          ) : (
            <div className="flex gap-2 max-lg:pl-10">
              <Button
                ref={editRef}
                data-row-action="edit"
                variant="outline"
                aria-label={`Edit products for ${handle}`}
                onClick={() => {
                  setDraft(person.products.map((p) => p.key));
                  changeMode("edit");
                }}
              >
                Edit products
              </Button>
              <Button
                ref={removeRef}
                variant="outline"
                aria-label={`Remove ${handle}`}
                className="text-destructive"
                onClick={() => changeMode("confirm")}
              >
                <Trash2Icon
                  data-icon="inline-start"
                  aria-hidden="true"
                  className="size-3.5"
                />
                Remove
              </Button>
            </div>
          )}
          {mode === "view" && sent && (
            <RowStatus
              error={failure}
              className="max-lg:pl-10 lg:basis-full lg:pl-60"
            />
          )}
        </>
      )}
    </li>
  );
}

/**
 * The owner's People page: invite by GitHub username or email with the products they may see,
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
    const now = new Set(props.people.map(personId));
    const goneAt = before.findIndex((p) => !now.has(personId(p)));
    if (goneAt === -1) return;
    const next = before.slice(goneAt + 1).find((p) => now.has(personId(p)));
    const nextEdit =
      next &&
      listRef.current?.querySelector<HTMLButtonElement>(
        `[data-person="${personId(next)}"] [data-row-action="edit"]`,
      );
    (nextEdit ?? headingRef.current)?.focus();
  }, [props.people]);
  return (
    // the 880px column sits inside the page padding, so the padding never narrows it
    <div className="w-full pt-3 lg:px-6 lg:py-6">
      <div className="mx-auto flex max-w-220 flex-col gap-6">
        <div className="px-4 lg:px-0">
          <InviteForm
            products={props.products}
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
            className="mb-1 font-medium outline-none max-lg:px-4"
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
            <ul ref={listRef}>
              {props.people.map((person) => (
                <PersonRow
                  key={personId(person)}
                  person={person}
                  products={props.products}
                  onSaveProducts={props.onSaveProducts}
                  onRemove={props.onRemove}
                  mutation={
                    props.rowMutations.find(
                      (write) => write.id === personId(person),
                    ) ?? null
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
