import { SearchIcon } from "lucide-react";
import { Fragment, type ReactNode, useId } from "react";
import { ActorAvatar, kindNoun } from "@/components/actor";
import { AppLink, RowLink } from "@/components/app-link";
import { FiltersSheet, TypeSelect } from "@/components/filter-select";
import { EmptyState } from "@/components/states";
import {
  type ItemType,
  PriorityLabel,
  priorityLabel,
  StatusIcon,
  statusLabel,
  TypeIcon,
  typeLabel,
} from "@/components/status";
import { Age } from "@/components/status-updates";
import { KeyPill, KeyText, LabelChip } from "@/components/text";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  WebItemCountsView,
  WebItemRowView,
  WebProductRefView,
} from "@/lib/api-types";
import {
  type StatusFilter,
  statusesOf,
  statusFilterOf,
} from "@/lib/item-status";
import { paths } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** The type toggle and the status tab; null is All. The URL is the route's. */
export type ItemFilters = {
  type: ItemType | null;
  status: StatusFilter | null;
};

export const NO_FILTERS: ItemFilters = { type: null, status: null };

// the 375 chips leave Canceled out, unless it is the filter in force
const workChipStatuses: readonly StatusFilter[] = [
  "open",
  "in_progress",
  "done",
];
const ALL = "all";

/** The filters under another type; a status that type has no tab for falls back to All. */
function withType(filters: ItemFilters, type: ItemType | null): ItemFilters {
  const keeps = filters.status && statusesOf(type).includes(filters.status);
  return { ...filters, type, status: keeps ? filters.status : null };
}

/**
 * Where FilterEmpty's Show all lands, `none` being the page's cleared filters. Notes
 * with a status drop only the status: All lists issues and todos, so clearing the type
 * would leave the notes altogether.
 */
export function showAllFilters<F extends ItemFilters>(filters: F, none: F): F {
  return filters.type === "note" && filters.status
    ? { ...filters, status: null }
    : none;
}

/** A tab's count by its value, All included; a status the type has no tab for has none. */
type StatusCounts = Partial<Record<StatusFilter | typeof ALL, number>>;

/** The status tabs' counts under `type`: notes are counted apart from the work types. */
function tabCounts(
  counts: WebItemCountsView,
  type: ItemType | null,
): StatusCounts {
  if (type !== "note") return counts[type ?? "all"];
  const { current, archived } = counts.notes;
  return { all: current + archived, current, archived };
}

/**
 * Whether a row belongs under the filters. The route fetches with them; this keeps rows
 * from a list still answering an earlier filter off the screen. Without a type, the list
 * is issues and todos: a note belongs only under Notes.
 */
export function matchesFilters(item: WebItemRowView, filters: ItemFilters) {
  if (filters.type ? item.type !== filters.type : item.type === "note")
    return false;
  if (!filters.status) return true;
  if (filters.status === "open")
    return item.status === "open" || item.status === "triage";
  return item.status === filters.status;
}

const typeOptions: { value: string; label: string; type: ItemType | null }[] = [
  { value: ALL, label: "All", type: null },
  { value: "issue", label: "Issues", type: "issue" },
  { value: "todo", label: "Todos", type: "todo" },
  { value: "note", label: "Notes", type: "note" },
];

/**
 * All (issues and todos), Issues, Todos or Notes, each with its count, on a segmented
 * track: 32px beside the status tabs at 1024px and up; 44px below, like the product select
 * it can share a row with, and as wide as it's let. `countsBelowLg={false}` drops the
 * counts there, on that shared row.
 */
export function TypeToggle({
  value,
  counts,
  onChange,
  countsBelowLg = true,
  className,
}: {
  value: ItemType | null;
  /** Null while the list loads: the words show alone. */
  counts: WebItemCountsView | null;
  onChange: (type: ItemType | null) => void;
  countsBelowLg?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label="Filter by type"
      value={[value ?? ALL]}
      onValueChange={(next) => {
        // pressing the current item again empties the group; keep the filter instead
        const picked = next[0];
        if (picked === undefined) return;
        const type = typeOptions.find((o) => o.value === picked)?.type ?? null;
        if (type !== value) onChange(type);
      }}
      variant="segmented"
      className={cn("max-lg:w-full", className)}
    >
      {typeOptions.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          // grown from its own width, not split evenly: "Issues 116" outgrows a quarter of 343px
          className="gap-1.25 text-xs max-lg:flex-auto max-lg:text-sm"
        >
          {option.label}
          {counts && (
            <>
              {" "}
              <span
                className={cn("text-2xs", !countsBelowLg && "max-lg:hidden")}
              >
                {tabCounts(counts, option.type).all}
              </span>
            </>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** All, then each status, with its count once the list has loaded. */
function statusOptions(
  statuses: readonly StatusFilter[],
  counts: StatusCounts | null,
) {
  return [
    { value: ALL, label: "All", count: counts?.all },
    ...statuses.map((status) => ({
      value: status,
      label: statusLabel(status),
      count: counts?.[status],
    })),
  ];
}

/**
 * The status tabs; render inside the `Tabs` whose value is the status filter. At 1024px
 * and up beside the type toggle. Below, only with `belowLg`: a full-bleed row on its own
 * rule that scrolls sideways, its right edge masked so a tab cut there reads as more.
 */
function StatusTabs({
  type,
  counts,
  belowLg,
}: {
  type: ItemType | null;
  counts: StatusCounts | null;
  belowLg: boolean;
}) {
  return (
    <TabsList
      variant="line"
      aria-label="Filter by status"
      className={cn(
        // at lg the bar draws the one rule, under the tabs' row
        // at lg the list sizes to its tabs, not the line variant's w-full, so the toggle can share its row
        "rounded-none p-0 lg:mt-0.5 lg:h-8 lg:gap-3 lg:data-[variant=line]:w-fit lg:data-[variant=line]:border-b-0",
        belowLg
          ? // the stock line variant's p-0 is an attribute selector, so the inset needs one too
            "max-lg:scrollbar-none max-lg:overflow-x-auto max-lg:mask-r-from-88% max-lg:data-[variant=line]:px-4"
          : "max-lg:hidden",
      )}
    >
      {statusOptions(statusesOf(type), counts).map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          className="flex-none px-1 font-normal text-muted-foreground data-active:text-foreground max-lg:min-w-11 max-lg:px-0 max-lg:data-active:font-medium lg:h-8"
        >
          {option.label}{" "}
          {option.count !== undefined && (
            <span className="text-muted-foreground lg:text-2xs">
              {option.count}
            </span>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** The Filters sheet's primary button; without a count while the list loads. */
function showItemsLabel(count: number | undefined, type: ItemType | null) {
  if (count === undefined) return `Show ${nouns[type ?? "all"]}`;
  return `Show ${count} ${itemNoun(count, type)}`;
}

function StatusChips({
  type,
  value,
  onChange,
}: {
  type: ItemType | null;
  value: StatusFilter | null;
  onChange: (status: StatusFilter | null) => void;
}) {
  const chipStatuses = type === "note" ? statusesOf("note") : workChipStatuses;
  // the row scrolls sideways; its right padding fades out, so a chip cut at the edge reads as more
  return (
    <ToggleGroup
      aria-label="Filter by status"
      value={[value ?? ALL]}
      onValueChange={(next) => {
        // pressing the current chip again empties the group; keep the filter instead
        if (next[0]) onChange(statusFilterOf(next[0]));
      }}
      className="w-full scrollbar-none overflow-x-auto px-4 pt-2.5 pb-3 mask-r-from-[calc(100%-var(--spacing)*4)] lg:hidden"
    >
      {statusOptions(
        value && !chipStatuses.includes(value)
          ? [...chipStatuses, value]
          : chipStatuses,
        null,
      ).map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          variant="outline"
          className="h-11 rounded-4xl px-3.5 font-normal text-muted-foreground aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * Status tabs with the type toggle at their right (after `select`, when given) at 1024px
 * and up. Below, by default the toggle on a row of its own over the status chips; with
 * `sheet`, the status tabs scroll in a row of their own over one Filters button, whose
 * sheet holds `sheet.select` and the type. The tab counts follow the type. Render inside
 * a `Tabs` whose value is `filters.status ?? "all"`.
 */
export function ItemFilterBar({
  filters,
  counts,
  onFiltersChange,
  select,
  sheet,
}: {
  filters: ItemFilters;
  counts: WebItemCountsView | null;
  onFiltersChange: (filters: ItemFilters) => void;
  select?: ReactNode;
  /** `select` as the sheet stacks it (with a `fieldLabel`), and whether it is in force. */
  sheet?: { select: ReactNode; active: boolean };
}) {
  const typeCounts = counts && tabCounts(counts, filters.type);
  const onTypeChange = (type: ItemType | null) =>
    onFiltersChange(withType(filters, type));
  return (
    // too narrow for both, the toggle wraps under the tabs, so it is drawn where it falls in
    // the Tab order. The rule is drawn at the first row's foot, under the tabs whether or
    // not the toggle shares their row: top-8.5 is the tabs' lg:mt-0.5 plus their lg:h-8.
    <div className="flex flex-col lg:relative lg:flex-row lg:flex-wrap lg:items-end lg:gap-x-4 lg:gap-y-2 lg:pb-px lg:after:absolute lg:after:inset-x-0 lg:after:top-8.5 lg:after:border-b lg:after:border-border">
      <StatusTabs
        type={filters.type}
        counts={typeCounts}
        belowLg={sheet !== undefined}
      />
      <div
        className={cn(
          "flex items-center gap-2 max-lg:px-4 max-lg:pt-3 lg:mb-0.5 lg:ml-auto",
          sheet && "max-lg:hidden",
        )}
      >
        {select}
        <TypeToggle
          value={filters.type}
          counts={counts}
          onChange={onTypeChange}
          countsBelowLg={!select}
          className="max-lg:flex-1"
        />
      </div>
      {sheet ? (
        <FiltersSheet
          activeCount={
            [sheet.active, filters.type !== null].filter(Boolean).length
          }
          doneLabel={showItemsLabel(
            typeCounts?.[filters.status ?? ALL],
            filters.type,
          )}
          className="mx-4 mt-3 self-start lg:hidden"
        >
          {sheet.select}
          <TypeSelect
            fieldLabel="Type"
            // null here is issues and todos, as on the lg toggle; notes list in their own section
            allLabel="All"
            value={filters.type}
            onChange={onTypeChange}
          />
        </FiltersSheet>
      ) : (
        <StatusChips
          type={filters.type}
          value={filters.status}
          onChange={(status) => onFiltersChange({ ...filters, status })}
        />
      )}
    </div>
  );
}

/** Lists, tabs and chips all read the same filter value off this. */
export const statusTabValue = (filters: ItemFilters) => filters.status ?? ALL;

// All holds issues and todos; notes list beside it, so "items" would deny them
const nouns: Record<ItemType | "all", string> = {
  all: "issues and todos",
  issue: "issues",
  todo: "todos",
  note: "notes",
};

/** Items exist, none under the filters: say which, and offer them all back. */
export function FilterEmpty({
  filters,
  onShowAll,
}: {
  filters: ItemFilters;
  onShowAll: () => void;
}) {
  // "or" where it negates: none of either
  const noun = filters.type ? nouns[filters.type] : "issues or todos";
  return (
    <EmptyState
      icon={SearchIcon}
      title={
        filters.status
          ? `No ${noun} are ${statusLabel(filters.status).toLowerCase()}`
          : `No ${noun} yet`
      }
      description="Try another filter."
      action={
        <Button variant="outline" size="sm" onClick={onShowAll}>
          Show all
        </Button>
      }
    />
  );
}

/**
 * An issue may be unassigned; a todo always has its bot and a note never has one, so
 * neither reads Unassigned.
 */
function Assignee({ item }: { item: WebItemRowView }) {
  if (!item.assignee) {
    return item.type === "issue" ? (
      <span className="text-muted-foreground">Unassigned</span>
    ) : null;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ActorAvatar actor={item.assignee} size="xs" />
      <span className="truncate">{item.assignee.name}</span>
    </span>
  );
}

/** The phone row's assignee: the name, with its kind for screen readers. */
function RowAssignee({ item }: { item: WebItemRowView }) {
  if (!item.assignee) {
    return item.type === "issue" ? <span>Unassigned</span> : null;
  }
  return (
    <span className="min-w-0 truncate">
      <span className="sr-only">Assigned to</span> {item.assignee.name}
      <span className="sr-only">, {kindNoun(item.assignee.kind)}</span>
    </span>
  );
}

/** `oneLine` keeps a table row at its height: labels past the cell's width clip. */
function Labels({
  labels,
  oneLine = false,
}: {
  labels: string[];
  oneLine?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1",
        oneLine ? "overflow-hidden" : "flex-wrap",
      )}
    >
      {labels.map((label) => (
        // the space keeps the names apart when read as text; flex drops it visually
        <Fragment key={label}>
          <LabelChip name={label} />{" "}
        </Fragment>
      ))}
    </span>
  );
}

function itemNoun(count: number, type: ItemType | null = null) {
  if (count !== 1) return nouns[type ?? "all"];
  return type ? nouns[type].slice(0, -1) : "issue or todo";
}

/** `trail TRL 8 issues and todos`, or `3 todos` under the type filter's Todos: a product group's heading, its key as a pill after the name. */
export function GroupHeading({
  product,
  count,
  type,
}: {
  product: WebProductRefView;
  count: number;
  /** The page's type filter; null is All. */
  type: ItemType | null;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-medium">{product.name}</span>{" "}
      <KeyPill>{product.key}</KeyPill>{" "}
      <span className="shrink-0 text-xs font-normal whitespace-nowrap text-muted-foreground">
        {count} {itemNoun(count, type)}
      </span>
    </span>
  );
}

/** Rows under a product heading; a list without groups has one, unheaded. */
export type ItemGroup = {
  product: WebProductRefView | null;
  count: number;
  items: WebItemRowView[];
};

/** A list holds notes only when filtered to them: without a type it holds issues and todos. */
const holdsWork = (groups: ItemGroup[]) =>
  groups.some((group) => group.items.some((item) => item.type !== "note"));

const head = "h-7.5 px-0";

/**
 * The 1024px table: status, type, key, title, priority, (labels,) assignee, updated; a list
 * of notes alone drops priority and assignee, which a note never has. A group with a product
 * gets a heading row; groups after the first sit 12px apart.
 */
export function ItemTable({
  groups,
  type,
  labels,
  now,
}: {
  groups: ItemGroup[];
  /** The page's type filter, which names the rows in a group's heading. */
  type: ItemType | null;
  labels: boolean;
  now: Date;
}) {
  const work = holdsWork(groups);
  const columns = 5 + (labels ? 1 : 0) + (work ? 2 : 0);
  return (
    <Table className="table-fixed max-lg:hidden">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(head, "w-8.5 pl-2")}>
            <span className="sr-only">Status</span>
          </TableHead>
          <TableHead className={cn(head, "w-5.5")}>
            <span className="sr-only">Type</span>
          </TableHead>
          <TableHead className={cn(head, "w-18")}>Key</TableHead>
          <TableHead className={head}>Title</TableHead>
          {work && (
            <TableHead className={cn(head, "w-21.5")}>Priority</TableHead>
          )}
          {labels && (
            <TableHead className={cn(head, "w-24.5")}>Labels</TableHead>
          )}
          {work && (
            <TableHead className={cn(head, "w-34.5")}>Assignee</TableHead>
          )}
          <TableHead className={cn(head, "w-15 pr-2 text-right")}>
            Updated
          </TableHead>
        </TableRow>
      </TableHeader>
      {groups.map((group, index) => (
        <TableBody
          key={group.product?.key ?? ""}
          data-group={group.product?.key}
        >
          {group.product && (
            <TableRow className="hover:bg-transparent">
              {/* the heading is the inner div, so the cell's top padding parts it from the group above: a tbody takes no margin */}
              <TableHead
                colSpan={columns}
                scope="colgroup"
                className={cn(
                  "h-auto p-0 text-sm text-foreground",
                  index > 0 && "pt-3",
                )}
              >
                <div className="flex h-8.5 items-center px-2">
                  <GroupHeading
                    product={group.product}
                    count={group.count}
                    type={type}
                  />
                </div>
              </TableHead>
            </TableRow>
          )}
          {group.items.map((item) => (
            <TableRow
              key={item.key}
              data-item-key={item.key}
              className="relative"
            >
              <TableCell className="py-2 pr-0 pl-2">
                <StatusIcon status={item.status} label />
              </TableCell>
              <TableCell className="px-0 py-2">
                <TypeIcon type={item.type} />
              </TableCell>
              <TableCell className="px-0 py-2">
                <KeyText>{item.key}</KeyText>
              </TableCell>
              <TableCell className="truncate px-0 py-2 pr-2.5">
                <RowLink
                  href={paths.issue(item.key)}
                  label={`${item.key} ${item.title}`}
                  className={cn(
                    item.status === "canceled" && "text-muted-foreground",
                  )}
                >
                  {item.title}
                </RowLink>
              </TableCell>
              {work && (
                <TableCell className="px-0 py-2">
                  <PriorityLabel priority={item.priority} />
                </TableCell>
              )}
              {labels && (
                <TableCell className="px-0 py-2 pr-2.5">
                  <Labels labels={item.labels} oneLine />
                </TableCell>
              )}
              {work && (
                <TableCell className="px-0 py-2 pr-2.5">
                  <Assignee item={item} />
                </TableCell>
              )}
              <TableCell className="py-2 pr-2 pl-0 text-right text-muted-foreground">
                <Age iso={item.updatedAt} now={now} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      ))}
    </Table>
  );
}

/**
 * Below 1024px, two lines a row beside the status glyph: the title; then the type glyph,
 * key, assignee, priority, labels and age in grey. The whole row is the link, named by
 * key and title and described by its type, status, assignee, priority and labels. A
 * group with a product gets a heading.
 */
export function ItemRows({
  groups,
  type,
  now,
}: {
  groups: ItemGroup[];
  /** The page's type filter, which names the rows in a group's heading. */
  type: ItemType | null;
  now: Date;
}) {
  const id = useId();
  return (
    <div className="lg:hidden">
      {groups.map((group) => (
        <section
          key={group.product?.key ?? ""}
          data-group={group.product?.key}
          aria-labelledby={
            group.product ? `${id}-${group.product.key}` : undefined
          }
        >
          {group.product && (
            <h3
              id={`${id}-${group.product.key}`}
              className="flex items-center px-4 pt-5 pb-0.5 font-normal"
            >
              <GroupHeading
                product={group.product}
                count={group.count}
                type={type}
              />
            </h3>
          )}
          <ul>
            {group.items.map((item) => {
              const typeId = `${id}-${item.key}-type`;
              const metaId = `${id}-${item.key}-meta`;
              return (
                <li
                  key={item.key}
                  data-item-key={item.key}
                  className="mx-4 border-b border-rule"
                >
                  <AppLink
                    href={paths.issue(item.key)}
                    aria-label={`${item.key} ${item.title}`}
                    aria-describedby={`${typeId} ${metaId}`}
                    className="flex gap-2.5 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <StatusIcon status={item.status} className="mt-0.75" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          item.status === "canceled" && "text-muted-foreground",
                        )}
                      >
                        {item.title}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <TypeIcon type={item.type} decorative />
                        <span id={typeId} className="sr-only">
                          {typeLabel(item.type)}
                        </span>
                        <KeyText>{item.key}</KeyText>{" "}
                        <span id={metaId} className="contents">
                          <span className="sr-only">
                            {statusLabel(item.status)}
                          </span>{" "}
                          <RowAssignee item={item} />{" "}
                          {item.type !== "note" && item.priority !== 0 && (
                            <span>{priorityLabel(item.priority)} </span>
                          )}
                          {item.labels.length > 0 && (
                            <Labels labels={item.labels} />
                          )}
                        </span>{" "}
                        <Age iso={item.updatedAt} now={now} />
                      </span>
                    </span>
                  </AppLink>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
