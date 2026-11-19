import { PackageIcon } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { ActorAvatar, BotTitle } from "@/components/actor";
import { AppLink, textLinkFocus, textLinkTap } from "@/components/app-link";
import { ProductSelect } from "@/components/filter-select";
import {
  FilterEmpty,
  ItemFilterBar,
  type ItemFilters,
  type ItemGroup,
  ItemRows,
  ItemTable,
  matchesFilters,
  showAllFilters,
  statusFilterOf,
  statusTabValue,
} from "@/components/item-list";
import { NotesSection } from "@/components/notes";
import {
  EmptyState,
  ErrorState,
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
  WebItemRowView,
  WebProjectDetailView,
  WebProjectItemsView,
  WebProjectView,
  WebStatusUpdatePageView,
} from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

/** The type toggle and status tab, plus one product's key or null for all. */
export type ProjectItemFilters = ItemFilters & { product: string | null };

export const NO_PROJECT_FILTERS: ProjectItemFilters = {
  type: null,
  status: null,
  product: null,
};

export type ProjectViewProps = {
  project: Loadable<WebProjectDetailView>;
  /** The groups under `filters`; `counts` follow the product filter alone. */
  items: Loadable<WebProjectItemsView>;
  /**
   * The tab counts under the product filter, held while the next tab's list loads; null
   * before any. A ready `items` draws its own; omitted, the tabs count only a ready list.
   */
  counts?: WebItemCountsView | null;
  /** The current notes under the product filter, for the Notes section under the list. */
  notes: Loadable<WebItemRowView[]>;
  /** The last note counts under the product filter, held while the next list loads; null before any. */
  noteCounts: WebItemCountsView["notes"] | null;
  /** Newest first. */
  statusUpdates: Loadable<WebStatusUpdatePageView>;
  filters: ProjectItemFilters;
  onFiltersChange: (filters: ProjectItemFilters) => void;
  onRetryProject: () => void;
  onRetryItems: () => void;
  onRetryNotes: () => void;
  onRetryStatusUpdates: () => void;
  /** Under the list, before Status updates below lg. */
  footer?: ReactNode;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/**
 * The shell heading on a project page: `Projects / Human UI launch` at 1440; below, the
 * Projects link over the name at 20px.
 */
export function ProjectHeading({ project }: { project: { name: string } }) {
  return (
    <span className="flex min-w-0 items-center gap-2 max-lg:flex-col max-lg:items-start max-lg:gap-1.5">
      <span className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
        <AppLink
          href={paths.projects}
          className={cn(textLinkFocus, textLinkTap, "hover:text-foreground")}
        >
          Projects
        </AppLink>
        <span aria-hidden="true" className="max-lg:hidden">
          /
        </span>
      </span>
      <span className="max-lg:text-xl max-lg:leading-tight max-lg:font-semibold lg:truncate">
        {project.name}
      </span>
    </span>
  );
}

/** The heading's accessory: health at the right of the Projects line below lg, only with a status update. */
export function ProjectHealth({ project }: { project: WebProjectView }) {
  return (
    <UpdateHealth
      of={project}
      className="max-lg:mt-0.5 max-lg:ml-auto max-lg:self-start"
    />
  );
}

const HIDDEN_PRODUCTS = "Items from products you can't see are not shown.";

/**
 * Lead, Target, Health and Products as a ledger. `aside` (1024px and up): a 72px label
 * column, the lead's title under the name, each product's name and key. `inline`
 * (below): Lead and Target alone in 36px rows on an 80px column, the title in line;
 * Health rides the heading there and the groups name the products.
 */
function ProjectDetails({
  project,
  layout,
  now,
}: {
  project: WebProjectDetailView;
  layout: "aside" | "inline";
  now: Date;
}) {
  const aside = layout === "aside";
  const label = "text-muted-foreground";
  return (
    <dl
      className={cn(
        "grid gap-x-2",
        aside
          ? "grid-cols-[--spacing(18)_1fr] items-start gap-y-2.5 pt-2.5"
          : "auto-rows-[minmax(--spacing(9),auto)] grid-cols-[--spacing(20)_1fr] items-center",
      )}
    >
      <dt className={label}>Lead</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <ActorAvatar actor={project.lead} size="xs" />
        <span className="min-w-0 truncate">{project.lead.name}</span>{" "}
        <span className={cn(aside && "order-last w-full pl-6.5")}>
          <BotTitle actor={project.lead} />
        </span>
      </dd>
      {project.targetDate && (
        <>
          <dt className={label}>Target</dt>
          <dd>
            <TargetDate date={project.targetDate} now={now} />
          </dd>
        </>
      )}
      {aside && project.latestStatusUpdate && project.health && (
        <>
          <dt className={label}>Health</dt>
          <dd>
            <UpdateHealth of={project} />
          </dd>
        </>
      )}
      {aside && (
        <>
          <dt className={label}>Products</dt>
          <dd className="flex flex-col gap-1.5">
            {project.products.map((product) => (
              <span
                key={product.key}
                className="flex min-w-0 items-center gap-2"
              >
                <span className="truncate">{product.name}</span>{" "}
                <KeyPill>{product.key}</KeyPill>
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

/** The groups' rows under the filters; a group left with none is not drawn. */
function visibleGroups(
  items: WebProjectItemsView,
  filters: ProjectItemFilters,
): ItemGroup[] {
  return items.groups
    .filter((g) => !filters.product || g.product.key === filters.product)
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => matchesFilters(item, filters)),
    }))
    .filter((g) => g.items.length > 0);
}

function ItemsBody({
  items,
  filters,
  onFiltersChange,
  onRetryItems,
  focusList,
  now,
}: {
  items: Loadable<WebProjectItemsView>;
  filters: ProjectItemFilters;
  onFiltersChange: (filters: ProjectItemFilters) => void;
  onRetryItems: () => void;
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
  const groups = visibleGroups(items.data, filters);
  // no filter to clear: the project's only items are its notes, under the list
  const unfiltered = !filters.type && !filters.status && !filters.product;
  if (groups.length === 0 && unfiltered) return <NoWork />;
  if (groups.length === 0) {
    return (
      <FilterEmpty
        filters={filters}
        onShowAll={() => {
          focusList();
          onFiltersChange(showAllFilters(filters, NO_PROJECT_FILTERS));
        }}
      />
    );
  }
  return (
    <>
      <ItemTable groups={groups} labels={false} now={now} />
      <ItemRows groups={groups} now={now} />
    </>
  );
}

function NoItems() {
  return (
    <EmptyState
      icon={PackageIcon}
      title="No items in this project yet"
      description="Bots add issues and todos to a project. They show up here, grouped by product."
    />
  );
}

function NoWork() {
  return (
    <EmptyState
      icon={PackageIcon}
      title="No issues or todos in this project yet"
      description="They show up here, grouped by product, once bots add them."
    />
  );
}

function ProjectBody(
  props: Omit<ProjectViewProps, "project" | "onRetryProject"> & {
    project: WebProjectDetailView;
    now: Date;
  },
) {
  const { project, items, filters, onFiltersChange, now } = props;
  const detailsHeading = useId();
  const updatesHeading = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const updatesHeadingRef = useRef<HTMLHeadingElement>(null);
  // no items at all leaves nothing to filter; none under a product filter is a filter
  // result, and notes alone keep the filters that list them
  const empty =
    items.status === "ready" &&
    items.data.counts.all.all === 0 &&
    items.data.counts.notes.current + items.data.counts.notes.archived === 0 &&
    filters.product === null;
  const counts =
    items.status === "ready" ? items.data.counts : (props.counts ?? null);
  const productSelect = (fieldLabel?: string) => (
    <ProductSelect
      products={project.products}
      fieldLabel={fieldLabel}
      value={filters.product}
      onChange={(product) => onFiltersChange({ ...filters, product })}
    />
  );

  return (
    <div className="flex flex-col lg:flex-row lg:gap-8 lg:px-6 lg:py-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex flex-col gap-3 px-4 pt-2 pb-4 lg:gap-2 lg:px-2 lg:pt-0 lg:pb-3.5",
            empty && "lg:border-b",
          )}
        >
          <div>
            <p className="text-xs text-muted-foreground max-lg:sr-only">Goal</p>
            <p className="max-w-155 max-lg:text-muted-foreground">
              {project.goal}
            </p>
          </div>
          <div className="lg:hidden">
            <ProjectDetails project={project} layout="inline" now={now} />
          </div>
          {project.hiddenProducts && (
            <p className="text-xs text-muted-foreground">{HIDDEN_PRODUCTS}</p>
          )}
        </div>
        {empty ? (
          <NoItems />
        ) : (
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
              onFiltersChange={(next) =>
                onFiltersChange({ ...filters, ...next })
              }
              select={productSelect()}
              sheet={{
                select: productSelect("Product"),
                active: filters.product !== null,
              }}
            />
            {/* one panel, keyed to whichever tab is current, so the list is that tab's panel */}
            <TabsContent
              ref={listRef}
              value={statusTabValue(filters)}
              tabIndex={-1}
              className="outline-none"
            >
              <ItemsBody
                items={items}
                filters={filters}
                onFiltersChange={onFiltersChange}
                onRetryItems={props.onRetryItems}
                focusList={() => listRef.current?.focus()}
                now={now}
              />
            </TabsContent>
          </Tabs>
        )}
        {props.footer}
        {filters.type !== "note" && (
          <NotesSection
            notes={props.notes}
            counts={props.noteCounts}
            onShowNotes={(status) => {
              listRef.current?.focus();
              onFiltersChange({ ...filters, type: "note", status });
            }}
            onRetry={props.onRetryNotes}
            now={now}
            className="mt-6"
          />
        )}
      </div>
      <aside className="flex flex-col gap-5 max-lg:pt-5 max-lg:pb-6 lg:w-75 lg:shrink-0">
        <section aria-labelledby={detailsHeading} className="max-lg:hidden">
          <AsideHeading id={detailsHeading}>Details</AsideHeading>
          <ProjectDetails project={project} layout="aside" now={now} />
        </section>
        <section aria-labelledby={updatesHeading}>
          <AsideHeading
            ref={updatesHeadingRef}
            id={updatesHeading}
            className="max-lg:px-4"
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
      </aside>
    </div>
  );
}

/**
 * A project: its goal, then its items grouped by product and filtered by product, type
 * and status, beside Details and status updates. Only the viewer's products ever show;
 * when the project has others, one line says items are missing, never which.
 */
export function ProjectView({
  project,
  onRetryProject,
  now: fixedNow,
  ...props
}: ProjectViewProps) {
  const now = useMinuteClock(fixedNow);
  if (project.status === "loading")
    return <ListSkeleton className="px-4 lg:px-6" />;
  if (project.status === "error") {
    return (
      <ErrorState
        title="Couldn't load this project"
        description="Check your connection, then try again."
        onRetry={onRetryProject}
      />
    );
  }
  return <ProjectBody {...props} project={project.data} now={now} />;
}
