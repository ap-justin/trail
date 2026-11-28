import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import type {
  ProgressHistoryPoint,
  ProjectProgress,
} from "../../shared/schemas.js";
import type { Db } from "../db/client.js";
import { type IssueStatus, issue, product, projectItem } from "../db/schema.js";
import type { Tx } from "./tx.js";

export type { ProjectProgress };

/** One of a project's issues or todos as progress reads it; notes never are. */
export type ProgressItem = {
  productKey: string;
  status: IssueStatus;
  estimate: number | null;
  completedAt: Date | null;
  joinedAt: Date;
};

/**
 * The issues and todos in these projects that `reached` (a condition over
 * project_item, the caller's visibility) admits, by project id; a project with
 * none has no entry.
 */
export function progressItems(
  db: Tx | Db,
  projectIds: string[],
  reached: SQL | undefined,
): Map<string, ProgressItem[]> {
  const of = new Map<string, ProgressItem[]>();
  if (projectIds.length === 0) return of;
  for (const { projectId, ...item } of db
    .select({
      projectId: projectItem.projectId,
      productKey: product.key,
      status: issue.status,
      estimate: issue.estimate,
      completedAt: issue.completedAt,
      joinedAt: projectItem.createdAt,
    })
    .from(projectItem)
    .innerJoin(issue, eq(issue.id, projectItem.issueId))
    .innerJoin(product, eq(product.id, projectItem.productId))
    .where(
      and(
        inArray(projectItem.projectId, projectIds),
        ne(issue.type, "note"),
        reached,
      ),
    )
    .all()) {
    const list = of.get(projectId);
    if (list) list.push(item);
    else of.set(projectId, [item]);
  }
  return of;
}

type Tally = {
  inScope: number;
  done: number;
  inProgress: number;
  open: number;
  hoursDone: number;
  hoursLeft: number;
  unfinishedWithoutEstimate: number;
};

const emptyTally = (): Tally => ({
  inScope: 0,
  done: 0,
  inProgress: 0,
  open: 0,
  hoursDone: 0,
  hoursLeft: 0,
  unfinishedWithoutEstimate: 0,
});

function add(t: Tally, item: ProgressItem): void {
  const hours = item.estimate ?? 0;
  if (item.status === "done") {
    t.done += 1;
    t.hoursDone += hours;
  } else if (item.status === "open" || item.status === "in_progress") {
    if (item.status === "open") t.open += 1;
    else t.inProgress += 1;
    t.hoursLeft += hours;
    if (item.estimate === null) t.unfinishedWithoutEstimate += 1;
  } else {
    return;
  }
  t.inScope += 1;
}

const oneDecimal = (hours: number) => Math.round(hours * 10) / 10;

/** `part` of `whole` as a whole percent that shows 0 only for none and 100 only for all. */
function wholePercent(part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0;
  if (part >= whole) return 100;
  return Math.min(99, Math.max(1, Math.round((part / whole) * 100)));
}

const DAY_MS = 86_400_000;

/** Milliseconds at the start of `at`'s UTC day. */
export const utcDay = (at: Date): number =>
  Math.floor(at.getTime() / DAY_MS) * DAY_MS;

function target(date: string | null, now: Date): ProjectProgress["target"] {
  if (date === null) return { date, status: "none", daysAway: null };
  const daysAway = Math.round((Date.parse(date) - utcDay(now)) / DAY_MS);
  const status =
    daysAway === 0 ? "today" : daysAway < 0 ? "overdue" : "upcoming";
  return { date, status, daysAway };
}

/**
 * A project's progress over `items`, the issues and todos of the products a
 * caller sees, with `products` those products A to Z by key: the one reading
 * both get_project and the web project page take, so they show one number.
 */
export function projectProgress(
  items: ProgressItem[],
  products: { key: string; name: string }[],
  targetDate: string | null,
  now: Date = new Date(),
): ProjectProgress {
  const all = emptyTally();
  const of = new Map(products.map((p) => [p.key, emptyTally()]));
  let itemsTriage = 0;
  let itemsCanceled = 0;
  for (const item of items) {
    if (item.status === "triage") itemsTriage += 1;
    if (item.status === "canceled") itemsCanceled += 1;
    add(all, item);
    const product = of.get(item.productKey);
    if (product) add(product, item);
  }
  const hoursEstimated = all.hoursDone + all.hoursLeft;
  return {
    itemsInScope: all.inScope,
    itemsDone: all.done,
    itemsInProgress: all.inProgress,
    itemsOpen: all.open,
    itemsTriage,
    itemsCanceled,
    donePercent: wholePercent(all.done, all.inScope),
    hoursEstimated: oneDecimal(hoursEstimated),
    hoursDone: oneDecimal(all.hoursDone),
    hoursLeft: oneDecimal(all.hoursLeft),
    hoursDonePercent: wholePercent(all.hoursDone, hoursEstimated),
    unfinishedWithoutEstimate: all.unfinishedWithoutEstimate,
    target: target(targetDate, now),
    byProduct: products.map((p) => {
      const t = of.get(p.key) ?? emptyTally();
      return {
        key: p.key,
        name: p.name,
        inScope: t.inScope,
        done: t.done,
        inProgress: t.inProgress,
        open: t.open,
        hoursLeft: oneDecimal(t.hoursLeft),
        unfinishedWithoutEstimate: t.unfinishedWithoutEstimate,
      };
    }),
  };
}

const inScope = (item: ProgressItem) =>
  item.status === "open" ||
  item.status === "in_progress" ||
  item.status === "done";

/** Past this many days the history keeps one point a week. */
const DAILY_HISTORY_DAYS = 120;

/**
 * Scope and done at the end of each UTC day, from the day the first item in
 * scope now joined through today: scope counts items in scope now by the day
 * they joined, done counts done items by the later of completing and joining.
 */
export function projectHistory(
  items: ProgressItem[],
  now: Date = new Date(),
): ProgressHistoryPoint[] {
  const scoped = items.filter(inScope);
  if (scoped.length === 0) return [];
  const dayOf = (at: Date) => Math.round((utcDay(at) - utcDay(now)) / DAY_MS);
  const joined = scoped.map((i) => dayOf(i.joinedAt));
  const done = scoped
    .filter((i) => i.status === "done")
    .map((i) =>
      Math.max(dayOf(i.completedAt ?? i.joinedAt), dayOf(i.joinedAt)),
    );
  const first = Math.min(...joined);
  const last = Math.max(0, first);
  const days: number[] = [];
  const step = last - first > DAILY_HISTORY_DAYS ? 7 : 1;
  for (let d = first; d < last; d += step) days.push(d);
  days.push(last);
  const byEnd = (dayList: number[], d: number) =>
    dayList.filter((x) => x <= d).length;
  return days.map((d) => ({
    date: new Date(utcDay(now) + d * DAY_MS).toISOString().slice(0, 10),
    scope: byEnd(joined, d),
    done: byEnd(done, d),
  }));
}
