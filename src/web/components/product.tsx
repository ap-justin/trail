import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { ActorAvatar } from "@/components/actor";
import { AppLink, RowLink, textLinkFocus } from "@/components/app-link";
import {
  FilterEmpty,
  ItemFilterBar,
  type ItemFilters,
  ItemRows,
  ItemTable,
  matchesFilters,
  NO_FILTERS,
  showAllFilters,
  statusFilterOf,
  statusTabValue,
} from "@/components/item-list";
import { NotesSection } from "@/components/notes";
import { Pane, PaneTabs } from "@/components/pane-tabs";
import {
  ItemListEmpty,
  ItemListError,
  ListSkeleton,
} from "@/components/states";
import {
  AsideHeading,
  StatusUpdateList,
  TargetDate,
  UpdateHealth,
} from "@/components/status-updates";
import { KeyPill } from "@/components/text";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import type {
  WebItemCountsView,
  WebItemListView,
  WebItemRowView,
  WebProductDetailView,
  WebProductRefView,
  WebProductView,
  WebProjectView,
  WebStatusUpdatePageView,
} from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

export type ProductViewProps = {
  /** Named from the session's product list until the detail loads. */
  product: WebProductRefView;
  /** The repo and projects for the aside; null while it loads. */
  detail: WebProductDetailView | null;
  /** The rows under `filters`; `counts` are per type and status whatever the filters. */
  items: Loadable<WebItemListView>;
  /**
   * The last list's counts, held while the next filter's list loads; null before any. Without
   * them the toggle and tabs count only a ready list.
   */
  counts?: WebItemCountsView | null;
  /** The current notes, for the Notes section under the list. */
  notes: Loadable<WebItemRowView[]>;
  /** The product's last note counts, held while the next filter's list loads; null before any. */
  noteCounts: WebItemCountsView["notes"] | null;
  /** Newest first. */
  statusUpdates: Loadable<WebStatusUpdatePageView>;
  filters: ItemFilters;
  onFiltersChange: (filters: ItemFilters) => void;
  onNewIssue: () => void;
  onRetryItems: () => void;
  onRetryNotes: () => void;
  onRetryStatusUpdates: () => void;
  /** Under the list, before its Notes section; hidden with the Items pane below lg. */
  footer?: ReactNode;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/** The shell heading on a product page: `Products / trail TRL` at 1440, `trail TRL` below. */
export function ProductHeading({ product }: { product: WebProductRefView }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex items-center gap-2 font-normal text-muted-foreground max-lg:hidden">
        <AppLink
          href={paths.products}
          className={cn(textLinkFocus, "hover:text-foreground")}
        >
          Products
        </AppLink>
        <span aria-hidden="true">/</span>
      </span>
      <span className="truncate">{product.name}</span>{" "}
      <KeyPill>{product.key}</KeyPill>
    </span>
  );
}

/** The heading's accessory: the latest status update's health, or nothing without one. */
export function ProductHealth({ product }: { product: WebProductView }) {
  return <UpdateHealth of={product} className="max-lg:ml-auto" />;
}

/** `github.com/owner/name` for a repo URL; `owner/name` with `short`. */
export function repoLabel(url: string, short = false): string {
  const { host, pathname } = new URL(url);
  const path = pathname.replace(/^\/|\/$/g, "");
  return short ? path : `${host}/${path}`;
}

/** The repo in mono with the external-link glyph; opens GitHub in a new tab. */
export function RepoLink({
  url,
  short = false,
  className,
}: {
  url: string;
  short?: boolean;
  className?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-2 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <span className="truncate font-mono text-xs">
        {repoLabel(url, short)}
      </span>
      <ExternalLinkIcon
        aria-label="(opens in a new tab)"
        role="img"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
    </a>
  );
}

function ItemsBody({
  product,
  items,
  filters,
  onFiltersChange,
  onNewIssue,
  onRetryItems,
  focusList,
  now,
}: Pick<
  ProductViewProps,
  | "product"
  | "items"
  | "filters"
  | "onFiltersChange"
  | "onNewIssue"
  | "onRetryItems"
> & {
  /** The Show all and Try again buttons unmount as the list reloads; focus waits on the list. */
  focusList: () => void;
  now: Date;
}) {
  if (items.status === "loading")
    return <ListSkeleton className="px-4 lg:px-2" />;
  if (items.status === "error")
    return (
      <ItemListError
        onRetry={() => {
          focusList();
          onRetryItems();
        }}
      />
    );
  // a list of notes is a filter result even where there is no work
  const { counts } = items.data;
  if (counts.all.all === 0 && filters.type !== "note") {
    return (
      <ItemListEmpty
        productKey={product.key}
        onlyNotes={counts.notes.current + counts.notes.archived > 0}
        onNewIssue={onNewIssue}
      />
    );
  }
  const rows = items.data.items.filter((item) => matchesFilters(item, filters));
  if (rows.length === 0) {
    return (
      <FilterEmpty
        filters={filters}
        onShowAll={() => {
          focusList();
          onFiltersChange(showAllFilters(filters, NO_FILTERS));
        }}
      />
    );
  }
  const groups = [{ product: null, count: rows.length, items: rows }];
  return (
    <>
      <ItemTable groups={groups} labels now={now} />
      <ItemRows groups={groups} now={now} />
    </>
  );
}

function ProjectItem({ project, now }: { project: WebProjectView; now: Date }) {
  return (
    <li className="relative flex flex-col gap-1 border-b border-rule py-2 max-lg:px-4 max-lg:py-3">
      <span className="flex min-w-0 items-center gap-2">
        <RowLink
          href={paths.project(project.slug)}
          className="min-w-0 flex-1 truncate font-medium"
        >
          {project.name}
        </RowLink>
        <UpdateHealth of={project} />
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <ActorAvatar actor={project.lead} size="xs" />
        <span className="truncate">{project.lead.name}</span>
        {project.targetDate && (
          <span className="ml-auto shrink-0">
            Target <TargetDate date={project.targetDate} now={now} />
          </span>
        )}
      </span>
    </li>
  );
}

type PaneName = "items" | "projects" | "updates";

/**
 * A product's items, filtered by type and status, and its current notes under them,
 * beside an aside of its repository, projects and status updates. Below 1024px the repo
 * sits under the heading and Items, Projects and Status updates switch.
 */
export function ProductView(props: ProductViewProps) {
  const now = useMinuteClock(props.now);
  const [pane, setPane] = useState<PaneName>("items");
  const repoHeading = useId();
  const projectsHeading = useId();
  const updatesHeading = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const updatesHeadingRef = useRef<HTMLHeadingElement>(null);
  const { detail, filters, onFiltersChange } = props;
  const projects = detail?.projects ?? [];
  const counts =
    props.items.status === "ready"
      ? props.items.data.counts
      : (props.counts ?? null);
  const panes: [PaneName, string][] = [
    ["items", "Items"],
    ...(projects.length > 0
      ? [["projects", "Projects"] as [PaneName, string]]
      : []),
    ["updates", "Status updates"],
  ];
  // the route keeps this view across products, so a pane the next one lacks falls back
  // to Items and stays there when that product's projects load
  if (!panes.some(([value]) => value === pane)) setPane("items");
  return (
    <Tabs
      value={pane}
      onValueChange={(next) => {
        const picked = panes.find(([value]) => value === next);
        if (picked) setPane(picked[0]);
      }}
      className="gap-0 lg:gap-8 lg:px-6 lg:py-4 lg:data-horizontal:flex-row"
    >
      {detail?.repoUrl && (
        <RepoLink
          url={detail.repoUrl}
          className="mx-4 mt-0.5 max-lg:min-h-11 lg:hidden"
        />
      )}
      <PaneTabs panes={panes} className="mt-1.5" />
      <Pane value="items" className="min-w-0 flex-1">
        <Tabs
          value={statusTabValue(filters)}
          onValueChange={(value) => {
            const status = statusFilterOf(String(value));
            if (status !== filters.status)
              onFiltersChange({ ...filters, status });
          }}
          className="gap-1"
        >
          <ItemFilterBar
            filters={filters}
            counts={counts}
            onFiltersChange={onFiltersChange}
          />
          {/* one panel, keyed to whichever tab is current, so the list is that tab's panel */}
          <TabsContent
            ref={listRef}
            value={statusTabValue(filters)}
            tabIndex={-1}
            className="outline-none"
          >
            <ItemsBody
              {...props}
              focusList={() => listRef.current?.focus()}
              now={now}
            />
          </TabsContent>
        </Tabs>
        {props.footer}
        {filters.type !== "note" && (
          <NotesSection
            notes={props.notes}
            counts={props.noteCounts}
            onShowNotes={(status) => {
              listRef.current?.focus();
              onFiltersChange({ type: "note", status });
            }}
            onRetry={props.onRetryNotes}
            now={now}
            className="mt-6"
          />
        )}
      </Pane>
      <aside className="flex flex-col gap-5 lg:w-70 lg:shrink-0">
        {detail?.repoUrl && (
          <section aria-labelledby={repoHeading} className="max-lg:hidden">
            <AsideHeading id={repoHeading}>Repository</AsideHeading>
            <RepoLink url={detail.repoUrl} className="pt-2 pb-1" />
          </section>
        )}
        {projects.length > 0 && (
          <Pane value="projects">
            <section aria-labelledby={projectsHeading}>
              <AsideHeading id={projectsHeading} className="max-lg:sr-only">
                Projects{" "}
                <span className="font-normal text-muted-foreground">
                  {detail?.projectCount}
                </span>
              </AsideHeading>
              <ul>
                {projects.map((project) => (
                  <ProjectItem key={project.slug} project={project} now={now} />
                ))}
              </ul>
            </section>
          </Pane>
        )}
        <Pane value="updates">
          <section aria-labelledby={updatesHeading}>
            <AsideHeading
              ref={updatesHeadingRef}
              id={updatesHeading}
              className="max-lg:sr-only"
            >
              Status updates
            </AsideHeading>
            <StatusUpdateList
              updates={props.statusUpdates}
              onRetry={() => {
                updatesHeadingRef.current?.focus();
                props.onRetryStatusUpdates();
              }}
            />
          </section>
        </Pane>
      </aside>
    </Tabs>
  );
}
