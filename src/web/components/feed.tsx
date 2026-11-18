import { BotIcon, FolderIcon } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";
import { ActorAvatar, ActorName, BotTitle } from "@/components/actor";
import { RowLink } from "@/components/app-link";
import {
  FilterSelect,
  FiltersSheet,
  ProductSelect,
  TypeSelect,
} from "@/components/filter-select";
import { MarkdownText } from "@/components/markdown-text";
import {
  FeedEmpty,
  FeedError,
  FeedFilterEmpty,
  FeedNoProducts,
  LoadingRegion,
  SkeletonBlock,
} from "@/components/states";
import {
  HealthPill,
  PriorityLabel,
  StatusLabel,
  TypeIcon,
  typeLabel,
} from "@/components/status";
import { KeyPill, KeyText, LabelChip } from "@/components/text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WorkingNow } from "@/components/working-now";
import type {
  EntryView,
  FeedView as FeedPage,
  WebItemRefView,
  WebItemType,
  WebProductRefView,
  WebProjectRefView,
  WebWorkingNowView,
} from "@/lib/api-types";
import { paths } from "@/lib/paths";
import {
  dayKey,
  formatAbsolute,
  formatDayHeader,
  formatRelative,
} from "@/lib/time";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

export type FeedConnection = "open" | "reconnecting";

export type FeedViewProps = {
  status: "loading" | "error" | "ready";
  /** Newest first. */
  entries: EntryView[];
  /** Entries received over SSE in the last 2 seconds; only these are highlighted. */
  freshIds: ReadonlySet<string>;
  connection: FeedConnection;
  /** Entries held back while the viewer is scrolled away from the top. */
  pendingCount: number;
  /** The "N new" pill was pressed: the list is back at the top, so merge them in. */
  onShowPending: () => void;
  /** Whether the top of the list is in view; while it isn't, hold new entries as pending. */
  onAtTopChange: (atTop: boolean) => void;
  /** Bots that acted in a visible product, the visible products and the visible projects. */
  filters: FeedPage["filters"];
  /** A bot's actor id, or null for all bots. */
  actorFilter: string | null;
  /** A product key, or null for all products. */
  productFilter: string | null;
  /** A project slug, or null for all projects. */
  projectFilter: string | null;
  /** Issues or todos only, or null for every kind of entry. */
  typeFilter: WebItemType | null;
  onActorFilterChange: (actorId: string | null) => void;
  onProductFilterChange: (productKey: string | null) => void;
  onProjectFilterChange: (projectSlug: string | null) => void;
  onTypeFilterChange: (type: WebItemType | null) => void;
  onRetry: () => void;
  /** `GET /api/web/working-now`, for the Working now strip; it hides while undefined or `total` is 0. */
  workingNow?: WebWorkingNowView;
  /** The viewer is a member with no product, so an empty feed is about access, not quiet. */
  noProducts?: boolean;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/** The top bar's `Live` mark while the SSE connection is open. */
export function LiveIndicator({ connection }: { connection: FeedConnection }) {
  if (connection !== "open") return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-success">
      <span aria-hidden="true" className="size-1.75 rounded-full bg-current" />
      Live
    </span>
  );
}

export function FeedView(props: FeedViewProps) {
  const now = useMinuteClock(props.now);
  const topRef = useRef<HTMLDivElement>(null);
  const reportAtTop = useEffectEvent((atTop: boolean) =>
    props.onAtTopChange(atTop),
  );

  useEffect(() => {
    const top = topRef.current;
    if (!top) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) reportAtTop(entry.isIntersecting);
    });
    observer.observe(top);
    return () => observer.disconnect();
  }, []);

  // the pill unmounts once the pending entries merge, so focus lands on the first day instead
  const firstDayRef = useRef<HTMLHeadingElement>(null);
  const focusFirstDayOnMerge = useRef(false);
  useEffect(() => {
    if (props.pendingCount > 0 || !focusFirstDayOnMerge.current) return;
    focusFirstDayOnMerge.current = false;
    firstDayRef.current?.focus();
  }, [props.pendingCount]);

  // Clear filters unmounts with the empty state, so focus waits on the filters
  const filtersRef = useRef<HTMLFieldSetElement>(null);
  const clearFilters = () => {
    filtersRef.current?.focus();
    if (props.actorFilter !== null) props.onActorFilterChange(null);
    if (props.productFilter !== null) props.onProductFilterChange(null);
    if (props.projectFilter !== null) props.onProjectFilterChange(null);
    if (props.typeFilter !== null) props.onTypeFilterChange(null);
  };

  const showPending = () => {
    topRef.current?.scrollIntoView({ block: "start" });
    focusFirstDayOnMerge.current = true;
    props.onShowPending();
  };

  // a member with no product has nothing to filter or wait for yet
  const nothingToFollow = props.noProducts && props.entries.length === 0;

  return (
    // the 880px column sits inside the page padding, so the padding never narrows it;
    // isolate keeps the pill's z-10 inside the feed, under the shell's sticky z-10 top bar and its search
    <div className="isolate w-full lg:px-6 lg:py-4">
      <div className="mx-auto flex max-w-220 flex-col">
        <div ref={topRef} />
        <WorkingNow
          workingNow={props.workingNow}
          className="px-4 pt-2 lg:px-3 lg:pt-0 lg:pb-2"
        />
        {!nothingToFollow && <FeedFilters {...props} ref={filtersRef} />}
        {props.pendingCount > 0 && (
          // zero height so the pill floats over the rows instead of pushing them down
          <div className="sticky top-15 z-10 flex h-0 justify-center">
            <Button
              size="sm"
              className="rounded-4xl shadow-md"
              onClick={showPending}
            >
              {props.pendingCount} new
            </Button>
          </div>
        )}
        {props.connection === "reconnecting" && !nothingToFollow && (
          <Alert className="mx-4 mt-3 w-auto border-0 bg-warning-muted py-1.5 text-xs font-medium text-warning lg:mx-0">
            <AlertDescription className="text-xs text-current">
              Reconnecting… new activity will appear when it's back.
            </AlertDescription>
          </Alert>
        )}
        <p role="status" className="sr-only">
          {newEntriesMessage(props.pendingCount || props.freshIds.size)}
        </p>
        <FeedBody
          {...props}
          now={now}
          firstDayRef={firstDayRef}
          onClearFilters={clearFilters}
        />
      </div>
    </div>
  );
}

function newEntriesMessage(count: number) {
  if (count === 0) return "";
  return `${count} new ${count === 1 ? "entry" : "entries"}`;
}

function FeedBody({
  status,
  entries,
  freshIds,
  connection,
  onRetry,
  noProducts,
  now,
  firstDayRef,
  actorFilter,
  productFilter,
  projectFilter,
  typeFilter,
  onClearFilters,
}: FeedViewProps & {
  now: Date;
  firstDayRef: Ref<HTMLHeadingElement>;
  onClearFilters: () => void;
}) {
  if (status === "loading") return <FeedSkeleton />;
  if (status === "error") return <FeedError onRetry={onRetry} />;
  if (entries.length === 0) {
    if (noProducts) return <FeedNoProducts />;
    const filtered =
      actorFilter !== null ||
      productFilter !== null ||
      projectFilter !== null ||
      typeFilter !== null;
    return filtered ? (
      <FeedFilterEmpty onClear={onClearFilters} />
    ) : (
      <FeedEmpty />
    );
  }
  return (
    <div className={cn(connection === "reconnecting" && "opacity-60")}>
      {groupByDay(shownRows(entries)).map((day, index) => (
        <section key={day.key}>
          <h2
            {...(index === 0 && { ref: firstDayRef, tabIndex: -1 })}
            className="px-4 pt-3.5 pb-1.5 text-xs font-medium text-muted-foreground outline-none lg:px-3 lg:pt-4"
          >
            {formatDayHeader(day.iso, now)}
          </h2>
          <ul>
            {day.rows.map(({ entry, sentence }) => (
              <FeedRow
                key={entry.id}
                entry={entry}
                sentence={sentence}
                fresh={freshIds.has(entry.id)}
                now={now}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

type Row = { entry: EntryView; sentence: Sentence };

/** Drops entries of a kind this bundle predates, so a new server kind can't break an open tab. */
function shownRows(entries: EntryView[]): Row[] {
  return entries.flatMap((entry) => {
    const sentence = sentenceFor(entry);
    return sentence ? [{ entry, sentence }] : [];
  });
}

function groupByDay(rows: Row[]) {
  const days: { key: string; iso: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const key = dayKey(row.entry.createdAt);
    const last = days.at(-1);
    if (last?.key === key) last.rows.push(row);
    else days.push({ key, iso: row.entry.createdAt, rows: [row] });
  }
  return days;
}

function FeedFilters({
  status,
  entries,
  filters,
  actorFilter,
  productFilter,
  projectFilter,
  typeFilter,
  onActorFilterChange,
  onProductFilterChange,
  onProjectFilterChange,
  onTypeFilterChange,
  ref,
}: FeedViewProps & { ref: Ref<HTMLFieldSetElement> }) {
  const actorOptions = filters.actors.map((a) => ({
    value: a.id,
    label: a.name,
    after: <BotTitle actor={a} className="shrink-0" />,
  }));
  const projectOptions = filters.projects.map((p) => ({
    value: p.slug,
    label: p.name,
  }));
  // the chips from lg; below, the same four stacked in the Filters sheet
  const selects = (inSheet: boolean) => (
    <>
      <FilterSelect
        label="Filter by bot"
        fieldLabel={inSheet ? "Bot" : undefined}
        allLabel="All bots"
        icon={BotIcon}
        options={actorOptions}
        value={actorFilter}
        onChange={onActorFilterChange}
      />
      <ProductSelect
        fieldLabel={inSheet ? "Product" : undefined}
        products={filters.products}
        value={productFilter}
        onChange={onProductFilterChange}
      />
      <FilterSelect
        label="Filter by project"
        fieldLabel={inSheet ? "Project" : undefined}
        allLabel="All projects"
        icon={FolderIcon}
        options={projectOptions}
        value={projectFilter}
        onChange={onProjectFilterChange}
      />
      <TypeSelect
        fieldLabel={inSheet ? "Type" : undefined}
        value={typeFilter}
        onChange={onTypeFilterChange}
      />
    </>
  );
  const activeCount = [
    actorFilter,
    productFilter,
    projectFilter,
    typeFilter,
  ].filter((filter) => filter !== null).length;
  return (
    <fieldset
      ref={ref}
      aria-label="Filter the feed"
      tabIndex={-1}
      className="flex items-center gap-2 px-4 pt-2 outline-none lg:px-3 lg:pt-0"
    >
      <FiltersSheet
        activeCount={activeCount}
        doneLabel={showEventsLabel(
          status === "ready" ? shownRows(entries).length : null,
        )}
        className="lg:hidden"
      >
        {selects(true)}
      </FiltersSheet>
      <div className="flex flex-wrap items-center gap-2 max-lg:hidden">
        {selects(false)}
      </div>
    </fieldset>
  );
}

/** The Filters sheet's primary button; without a count while the feed loads or failed. */
function showEventsLabel(count: number | null) {
  if (count === null) return "Show events";
  return `Show ${count} ${count === 1 ? "event" : "events"}`;
}

function FeedSkeleton() {
  const widths = [
    ["w-7/10", "w-2/5"],
    ["w-3/5", "w-4/5"],
    ["w-3/4", "w-3/10"],
    ["w-11/20", "w-9/20"],
  ] as const;
  return (
    <LoadingRegion className="flex flex-col gap-3 px-4 pt-4 lg:px-3">
      {widths.map(([first, second]) => (
        <div key={first} className="flex items-center gap-2.5">
          <SkeletonBlock className="size-6 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonBlock className={first} />
            <SkeletonBlock className={second} />
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}

type Sentence = {
  /** Before the subject: "changed status of". */
  verb: ReactNode;
  subject: ReactNode;
  /** The item title (or link title) the subject names; its own line at 375. */
  title?: string;
  /** After the subject: "to In progress". */
  tail?: ReactNode;
  quote?: string;
  sourceAuthor?: string | null;
};

/** The item's type glyph, then its key as the row's link. */
function itemSubject(item: WebItemRefView) {
  return (
    <>
      <TypeIcon type={item.type} />
      <RowLink href={paths.issue(item.key)} label={`${item.key} ${item.title}`}>
        <KeyText>{item.key}</KeyText>
      </RowLink>
    </>
  );
}

function productSubject(product: WebProductRefView) {
  return (
    <RowLink
      href={paths.product(product.key)}
      // spans with no space between would be read as one word: "OpenBotOPB"
      label={`${product.name} ${product.key}`}
      className="inline-flex items-center gap-1.5 font-medium"
    >
      {product.name}
      <KeyPill>{product.key}</KeyPill>
    </RowLink>
  );
}

function projectSubject(project: WebProjectRefView) {
  return (
    <RowLink href={paths.project(project.slug)} className="font-medium">
      {project.name}
    </RowLink>
  );
}

const muted = (text: string) => (
  <span className="text-muted-foreground">{text}</span>
);

/** "posted a status update on", short to "status update on" below lg. */
const statusUpdateVerb = (on: "product" | "project") => (
  <span className="text-muted-foreground">
    <span className="max-lg:hidden">posted a </span>status update on {on}
  </span>
);

function sentenceFor(entry: EntryView): Sentence | null {
  switch (entry.kind) {
    case "item_created":
      return {
        verb: muted(entry.createdAs === "todo" ? "planned" : "filed"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        sourceAuthor: entry.sourceAuthor,
      };
    case "status_changed":
      return {
        verb: muted("changed status of"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        tail: (
          <>
            {muted("to")}
            <StatusLabel status={entry.to} namesTriage />
          </>
        ),
      };
    case "type_changed":
      return {
        verb: muted("changed type of"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        tail: (
          <>
            {muted("to")}
            <span>{typeLabel(entry.to)}</span>
          </>
        ),
      };
    case "priority_changed":
      return {
        verb: muted("changed priority of"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        tail: (
          <>
            {muted("to")}
            <PriorityLabel priority={entry.to} />
          </>
        ),
      };
    case "labels_changed":
      return {
        verb: muted("changed labels on"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        tail: (
          <>
            {entry.added.length > 0 && muted("added")}
            {entry.added.map((name) => (
              <LabelChip key={`+${name}`} name={name} />
            ))}
            {entry.removed.length > 0 && muted("removed")}
            {entry.removed.map((name) => (
              <LabelChip key={`-${name}`} name={name} />
            ))}
          </>
        ),
      };
    case "link_added":
      return {
        verb: muted("added a link to"),
        subject: itemSubject(entry.item),
        title: entry.link.title,
      };
    case "assignee_changed":
      return entry.to
        ? {
            verb: muted("assigned"),
            subject: itemSubject(entry.item),
            title: entry.item.title,
            tail: (
              <>
                {muted("to")}
                <ActorAvatar actor={entry.to} size="xs" />
                <span className="font-medium">{entry.to.name}</span>
              </>
            ),
          }
        : {
            verb: muted("unassigned"),
            subject: itemSubject(entry.item),
            title: entry.item.title,
          };
    case "estimate_changed":
      return entry.to === null
        ? {
            verb: muted("cleared the estimate of"),
            subject: itemSubject(entry.item),
            title: entry.item.title,
          }
        : {
            verb: muted("changed estimate of"),
            subject: itemSubject(entry.item),
            title: entry.item.title,
            tail: (
              <>
                {muted("to")}
                <span>{entry.to}h</span>
              </>
            ),
          };
    case "comment":
      return {
        verb: muted("commented on"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        quote: entry.comment.body,
        sourceAuthor: entry.comment.sourceAuthor,
      };
    // the item is the row's link, so the project is named in plain text
    case "added_to_project":
      return {
        verb: muted("added"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        tail: (
          <>
            {muted("to project")}
            <span className="font-medium">{entry.project.name}</span>
          </>
        ),
      };
    case "removed_from_project":
      return {
        verb: muted("removed"),
        subject: itemSubject(entry.item),
        title: entry.item.title,
        tail: (
          <>
            {muted("from project")}
            <span className="font-medium">{entry.project.name}</span>
          </>
        ),
      };
    case "product_status_update":
      return {
        verb: statusUpdateVerb("product"),
        subject: productSubject(entry.product),
        tail: <HealthPill health={entry.statusUpdate.health} />,
        quote: entry.statusUpdate.body,
        sourceAuthor: entry.statusUpdate.sourceAuthor,
      };
    case "project_status_update":
      return {
        verb: statusUpdateVerb("project"),
        subject: projectSubject(entry.project),
        tail: <HealthPill health={entry.statusUpdate.health} />,
        quote: entry.statusUpdate.body,
        sourceAuthor: entry.statusUpdate.sourceAuthor,
      };
    case "product_created":
      return {
        verb: muted("created"),
        subject: productSubject(entry.product),
      };
    case "product_imported": {
      // an import that only touched labels, status updates or the product row counts 0 of both
      const counts = [
        entry.imported.issues > 0 && countOf(entry.imported.issues, "issue"),
        entry.imported.comments > 0 &&
          countOf(entry.imported.comments, "comment"),
      ].filter(Boolean);
      return {
        verb: muted("imported"),
        subject: productSubject(entry.product),
        tail: counts.length > 0 && (
          <>
            {muted("with")}
            <span>{counts.join(", ")}</span>
          </>
        ),
      };
    }
    case "project_created":
      return {
        verb: muted("created project"),
        subject: projectSubject(entry.project),
      };
    case "project_updated":
      return {
        verb: muted("updated project"),
        subject: projectSubject(entry.project),
      };
    default:
      // typechecks only while every known kind has a case; at runtime, a kind the server added later lands here
      entry satisfies never;
      return null;
  }
}

const countOf = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

export function RowTime({ iso, now }: { iso: string; now: Date }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

/**
 * One feed entry. At 1440 the sentence runs on one wrapping line with the product
 * key and time at the right; below 1024 it stacks: who and when, then the verb, then
 * the title. The line wrappers turn into `display: contents` at 1440 so one DOM
 * serves both.
 */
function FeedRow({
  entry,
  sentence,
  fresh,
  now,
}: Row & {
  fresh: boolean;
  now: Date;
}) {
  return (
    <li
      data-entry-id={entry.id}
      className={cn(
        "relative flex items-start gap-2.5 px-4 py-3 lg:rounded-xl lg:px-3 lg:py-2.5",
        fresh && "row-fresh",
      )}
    >
      <ActorAvatar actor={entry.actor} className="mt-px" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-1.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 lg:contents">
          <ActorName actor={entry.actor} nameClassName="font-medium" />
          {sentence.sourceAuthor && (
            <span className="text-2xs text-muted-foreground">
              originally by {sentence.sourceAuthor}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground lg:hidden">
            <RowTime iso={entry.createdAt} now={now} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 lg:contents">
          {sentence.verb}
          {sentence.subject}
          {sentence.title && (
            <span aria-hidden="true" className="max-lg:hidden">
              {sentence.title}
            </span>
          )}
          {sentence.tail}
        </div>
        {sentence.title && (
          <div aria-hidden="true" className="truncate lg:hidden">
            {sentence.title}
          </div>
        )}
        {sentence.quote && (
          <p className="mt-0.5 line-clamp-2 text-muted-foreground lg:basis-full">
            <MarkdownText source={sentence.quote} />
          </p>
        )}
      </div>
      {/* empty on a project's own entries, which belong to no product */}
      <span data-product-column className="min-w-8 text-right max-lg:hidden">
        {entry.product && <KeyPill>{entry.product.key}</KeyPill>}
      </span>
      <span className="w-14 text-right text-xs whitespace-nowrap text-muted-foreground max-lg:hidden">
        <RowTime iso={entry.createdAt} now={now} />
      </span>
    </li>
  );
}
