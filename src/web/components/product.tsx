import { ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";
import { ActorAvatar } from "@/components/actor";
import { AppLink, RowLink } from "@/components/app-link";
import {
  FilterEmpty,
  ItemFilterBar,
  type ItemFilters,
  ItemRows,
  ItemTable,
  matchesFilters,
  NO_FILTERS,
  statusFilterOf,
  statusTabValue,
} from "@/components/item-list";
import {
  IssueListEmpty,
  IssueListError,
  ListSkeleton,
} from "@/components/states";
import {
  AsideHeading,
  StatusUpdateList,
  TargetDate,
  UpdateHealth,
} from "@/components/status-updates";
import { KeyText } from "@/components/text";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  WebItemListView,
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
  /** Newest first. */
  statusUpdates: Loadable<WebStatusUpdatePageView>;
  filters: ItemFilters;
  onFiltersChange: (filters: ItemFilters) => void;
  onNewIssue: () => void;
  onRetryItems: () => void;
  onRetryStatusUpdates: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/** The shell heading on a product page: `Products / TRL trail` at 1440, `TRL trail` below. */
export function ProductHeading({ product }: { product: WebProductRefView }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex items-center gap-2 font-normal text-muted-foreground max-lg:hidden">
        <AppLink href={paths.products} className="hover:text-foreground">
          Products
        </AppLink>
        <span aria-hidden="true">/</span>
      </span>
      <KeyText className="text-sm text-foreground">{product.key}</KeyText>{" "}
      <span className="truncate">{product.name}</span>
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
        "inline-flex max-w-full min-w-0 items-center gap-2 rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/25",
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
  now,
}: Pick<
  ProductViewProps,
  | "product"
  | "items"
  | "filters"
  | "onFiltersChange"
  | "onNewIssue"
  | "onRetryItems"
> & { now: Date }) {
  if (items.status === "loading")
    return <ListSkeleton className="px-4 lg:px-2" />;
  if (items.status === "error")
    return <IssueListError onRetry={onRetryItems} />;
  if (items.data.counts.all.all === 0) {
    return <IssueListEmpty projectKey={product.key} onNewIssue={onNewIssue} />;
  }
  const rows = items.data.items.filter((item) => matchesFilters(item, filters));
  if (rows.length === 0) {
    return (
      <FilterEmpty
        filters={filters}
        onShowAll={() => onFiltersChange(NO_FILTERS)}
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
    <li className="relative flex flex-col gap-1 border-b py-2 max-lg:px-4 max-lg:py-3">
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

type Pane = "items" | "projects" | "updates";

/**
 * A product's items, filtered by type and status, beside an aside of its repository,
 * projects and status updates. Below 1024px the repo sits under the heading and Items,
 * Projects and Status updates switch.
 */
export function ProductView(props: ProductViewProps) {
  const now = useMinuteClock(props.now);
  const [pane, setPane] = useState<Pane>("items");
  const repoHeading = useId();
  const projectsHeading = useId();
  const updatesHeading = useId();
  const { detail, filters, onFiltersChange } = props;
  const projects = detail?.projects ?? [];
  const counts =
    props.items.status === "ready" ? props.items.data.counts : null;
  const panes: [Pane, string][] = [
    ["items", "Items"],
    ...(projects.length > 0
      ? [["projects", "Projects"] as [Pane, string]]
      : []),
    ["updates", "Status updates"],
  ];
  const hiddenUnless = (which: Pane) => pane !== which && "max-lg:hidden";

  return (
    <div className="flex flex-col lg:flex-row lg:gap-8 lg:px-6 lg:py-4">
      {detail?.repoUrl && (
        <RepoLink url={detail.repoUrl} className="mx-4 mt-0.5 lg:hidden" />
      )}
      <ToggleGroup
        aria-label="Show"
        value={[pane]}
        onValueChange={(next) => {
          const picked = panes.find(([value]) => value === next[0]);
          if (picked) setPane(picked[0]);
        }}
        spacing={4}
        className="mt-1.5 w-full rounded-none border-b px-4 lg:hidden"
      >
        {panes.map(([value, label]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className="-mb-px h-10 min-w-10 rounded-none border-b-2 border-transparent px-0.5 font-normal text-muted-foreground hover:bg-transparent aria-pressed:border-foreground aria-pressed:bg-transparent aria-pressed:text-foreground"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Tabs
        value={statusTabValue(filters)}
        onValueChange={(value) => {
          const status = statusFilterOf(String(value));
          if (status !== filters.status)
            onFiltersChange({ ...filters, status });
        }}
        className={cn("min-w-0 flex-1 gap-1", hiddenUnless("items"))}
      >
        <ItemFilterBar
          filters={filters}
          counts={counts}
          onFiltersChange={onFiltersChange}
        />
        {/* one panel, keyed to whichever tab is current, so the list is that tab's panel */}
        <TabsContent value={statusTabValue(filters)}>
          <ItemsBody {...props} now={now} />
        </TabsContent>
      </Tabs>
      <aside className="flex flex-col gap-5 lg:w-70 lg:shrink-0">
        {detail?.repoUrl && (
          <section aria-labelledby={repoHeading} className="max-lg:hidden">
            <AsideHeading id={repoHeading}>Repository</AsideHeading>
            <RepoLink url={detail.repoUrl} className="pt-2 pb-1" />
          </section>
        )}
        {projects.length > 0 && (
          <section
            aria-labelledby={projectsHeading}
            className={cn(hiddenUnless("projects"))}
          >
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
        )}
        <section
          aria-labelledby={updatesHeading}
          className={cn(hiddenUnless("updates"))}
        >
          <AsideHeading id={updatesHeading} className="max-lg:sr-only">
            Status updates
          </AsideHeading>
          <StatusUpdateList
            updates={props.statusUpdates}
            onRetry={props.onRetryStatusUpdates}
          />
        </section>
      </aside>
    </div>
  );
}
