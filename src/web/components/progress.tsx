import { type CSSProperties, type ReactNode, useId } from "react";
import { StatusIcon } from "@/components/status";
import { AsideHeading } from "@/components/status-updates";
import { KeyPill } from "@/components/text";
import type { ProjectProgress } from "@/lib/api-types";
import { daysUntil, formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";

type ProductProgress = ProjectProgress["byProduct"][number];

/** `292`, `24.5`: one decimal at most, the trailing zero dropped. */
export function formatHours(hours: number): string {
  return hours.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Done, in progress and open as one bar of rounded segments 2px apart, each as long as
 * its count; a status with none draws nothing. The figures are said in words beside it.
 */
export function StackedBar({
  done,
  inProgress,
  open,
  className,
  style,
}: {
  done: number;
  inProgress: number;
  open: number;
  className?: string;
  style?: CSSProperties;
}) {
  const segments = [
    { status: "done", count: done, ink: "bg-success" },
    { status: "in_progress", count: inProgress, ink: "bg-warning" },
    { status: "open", count: open, ink: "bg-accent" },
  ].filter((s) => s.count > 0);
  return (
    <div
      aria-hidden="true"
      data-bar
      className={cn("flex gap-0.5", className)}
      style={style}
    >
      {segments.map((s) => (
        <span
          key={s.status}
          data-segment={s.status}
          className={cn("h-full rounded-full", s.ink)}
          style={{ flexGrow: s.count, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

function CellLabel({ children }: { children: ReactNode }) {
  return (
    <p className="flex h-5 items-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

const cellValue = "block text-xl leading-snug font-semibold";

/** Triage and canceled sit outside every figure; one short line says how many. */
function uncountedLine(triage: number, canceled: number): string | null {
  const parts = [
    triage > 0 && `${triage} in triage`,
    canceled > 0 && `${canceled} canceled`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const verb = triage + canceled === 1 ? "isn't" : "aren't";
  return `${parts.join(" and ")} ${verb} counted.`;
}

function ProgressCell({ progress }: { progress: ProjectProgress }) {
  const legend = [
    { status: "done", label: "Done", count: progress.itemsDone, always: true },
    {
      status: "in_progress",
      label: "In progress",
      count: progress.itemsInProgress,
      always: false,
    },
    { status: "open", label: "Open", count: progress.itemsOpen, always: false },
  ] as const;
  const uncounted = uncountedLine(progress.itemsTriage, progress.itemsCanceled);
  return (
    <div className="col-span-2 @3xl:col-span-1">
      <CellLabel>Progress</CellLabel>
      <p className="flex items-baseline gap-2">
        <span className="text-display leading-tight font-semibold">
          {`${progress.donePercent}%`}
        </span>{" "}
        <span>{`${progress.itemsDone} of ${progress.itemsInScope} items done`}</span>
      </p>
      <StackedBar
        done={progress.itemsDone}
        inProgress={progress.itemsInProgress}
        open={progress.itemsOpen}
        className="mt-2.5 mb-2 h-2"
      />
      <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
        {legend
          .filter((l) => l.always || l.count > 0)
          .map((l) => (
            <li key={l.status} className="inline-flex items-center gap-1">
              <StatusIcon status={l.status} />
              {`${l.label} ${l.count}`}
            </li>
          ))}
      </ul>
      {uncounted && (
        <p className="mt-1.5 text-xs text-muted-foreground">{uncounted}</p>
      )}
    </div>
  );
}

function HoursCell({ progress }: { progress: ProjectProgress }) {
  const unfinished = progress.itemsOpen + progress.itemsInProgress;
  const unestimated = progress.unfinishedWithoutEstimate;
  // an estimate may be 0 h, so "none estimated" means every unfinished item lacks one
  if (
    progress.hoursEstimated === 0 &&
    unestimated > 0 &&
    unestimated === unfinished
  ) {
    return (
      <div>
        <CellLabel>Estimated work hours left</CellLabel>
        <p className={cn(cellValue, "text-muted-foreground")}>None estimated</p>
        <p className="mt-1 text-muted-foreground">
          {unestimated === 1
            ? "The unfinished item has no estimate."
            : `None of the ${unestimated} unfinished items has an estimate.`}
        </p>
      </div>
    );
  }
  // no estimated hours to divide, or a full bar over unestimated work left: no bar
  const bar =
    progress.hoursEstimated > 0 &&
    !(unestimated > 0 && progress.hoursLeft === 0);
  return (
    <div>
      <CellLabel>Estimated work hours left</CellLabel>
      <p className={cellValue}>{`${formatHours(progress.hoursLeft)} h`}</p>
      {bar && (
        <div aria-hidden="true" className="my-1.5 h-1 rounded-full bg-accent">
          <div
            data-hours-done
            className="h-full rounded-full bg-success"
            style={{
              width: `${(progress.hoursDone / progress.hoursEstimated) * 100}%`,
            }}
          />
        </div>
      )}
      {progress.hoursEstimated > 0 && (
        <p>
          {`${formatHours(progress.hoursDone)} of ${formatHours(progress.hoursEstimated)} estimated hours done (${progress.hoursDonePercent}%)`}
        </p>
      )}
      {unestimated > 0 && (
        <p className="mt-0.5 font-medium">
          {`${unestimated} ${plural(unestimated, "unfinished item has", "unfinished items have")} no estimate`}
        </p>
      )}
    </div>
  );
}

/** Days are counted from the viewer's local today; the server's `daysAway` is its UTC day. */
function TargetCell({
  progress,
  now,
}: {
  progress: ProjectProgress;
  now: Date;
}) {
  const { date } = progress.target;
  if (!date) {
    return (
      <div>
        <CellLabel>Target date</CellLabel>
        <p className={cn(cellValue, "text-muted-foreground")}>Not set</p>
        <p className="mt-1 text-muted-foreground">No target date yet.</p>
      </div>
    );
  }
  const days = daysUntil(date, now);
  const unfinished = progress.itemsOpen + progress.itemsInProgress > 0;
  const overdue = days < 0 && unfinished;
  return (
    <div>
      <CellLabel>Target date</CellLabel>
      <time
        dateTime={date}
        className={cn(cellValue, overdue && "text-destructive")}
      >
        {days === 0 ? "Today" : formatDate(date, now)}
      </time>
      {days > 0 && (
        <p className="mt-1 text-muted-foreground">
          {`in ${days} ${plural(days, "day", "days")}`}
        </p>
      )}
      {overdue && (
        <p className="mt-1 text-destructive">
          {`${-days} ${plural(-days, "day", "days")} overdue`}
        </p>
      )}
    </div>
  );
}

/**
 * Progress, estimated hours left and the target date, in three cells: one row on a wide
 * column, Progress over the other two on a narrow one. The page draws it only with items
 * in scope.
 */
export function ProgressSummary({
  progress,
  now,
  className,
}: {
  progress: ProjectProgress;
  /** The viewer's clock, for the days to the target. */
  now: Date;
  className?: string;
}) {
  return (
    <section aria-label="Progress" className={cn("@container", className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_--spacing(31)] gap-x-5 gap-y-4 @3xl:grid-cols-[--spacing(85)_--spacing(62.5)_minmax(0,1fr)] @3xl:gap-x-6">
        <ProgressCell progress={progress} />
        <HoursCell progress={progress} />
        <TargetCell progress={progress} now={now} />
      </div>
    </section>
  );
}

function productHoursLine(product: ProductProgress): string {
  const unfinished = product.inProgress + product.open;
  if (unfinished === 0) return "Nothing left";
  const unestimated = product.unfinishedWithoutEstimate;
  if (unestimated === unfinished && product.hoursLeft === 0)
    return "No estimates yet";
  const left = `${formatHours(product.hoursLeft)} h left`;
  return unestimated > 0
    ? `${left} · ${unestimated} without an estimate`
    : left;
}

/**
 * Each visible product's done of scope, a bar as long as its share of the largest
 * product's scope, and its hours left. A product with nothing in scope gets no row, and
 * the list is drawn only with two or more rows.
 */
export function ByProduct({
  products: all,
  className,
}: {
  products: ProductProgress[];
  className?: string;
}) {
  const headingId = useId();
  const products = all.filter((p) => p.inScope > 0);
  if (products.length < 2) return null;
  const largest = Math.max(...products.map((p) => p.inScope));
  return (
    <section aria-labelledby={headingId} className={className}>
      <AsideHeading id={headingId}>By product</AsideHeading>
      <ul className="flex flex-col gap-3.5 pt-1">
        {products.map((product) => (
          <li key={product.key}>
            <div className="flex items-center gap-2">
              <KeyPill>{product.key}</KeyPill>{" "}
              <span className="min-w-0 flex-1 truncate">{product.name}</span>{" "}
              <span className="whitespace-nowrap">
                {`${product.done} of ${product.inScope} done`}
              </span>
            </div>
            <StackedBar
              done={product.done}
              inProgress={product.inProgress}
              open={product.open}
              className="mt-1.5 h-1.5"
              style={{
                width: `${(product.inScope / largest) * 100}%`,
              }}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {productHoursLine(product)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
