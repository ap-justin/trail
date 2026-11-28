import { useId, useLayoutEffect, useRef, useState } from "react";
import { AsideHeading } from "@/components/status-updates";
import { burnUpGeometry, type HistoryPoint, type Point } from "@/lib/burn-up";
import { formatDate } from "@/lib/time";

// the 1440 frame's width; drawn at this until the container is measured (and in jsdom, which has no layout)
const DEFAULT_WIDTH = 520;

const points = (line: Point[]) => line.map(([x, y]) => `${x},${y}`).join(" ");

/** The container's content width, re-measured as it resizes; null before the first measure. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const measured = element.clientWidth;
      if (measured > 0) setWidth(measured);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function describeHistory(history: HistoryPoint[], now: Date) {
  const first = history[0] ?? { date: "", scope: 0, done: 0 };
  const last = history.at(-1) ?? first;
  const start = formatDate(first.date, now);
  const scopeRose = last.scope > first.scope;
  const doneRose = last.done > first.done;
  return {
    label: [
      scopeRose
        ? `Items in scope rose from ${first.scope} on ${start} to ${last.scope} today.`
        : `Items in scope stayed at ${last.scope} since ${start}.`,
      doneRose
        ? `Items done rose from ${first.done} to ${last.done}.`
        : `Items done stayed at ${last.done}.`,
    ].join(" "),
    summary: `Since ${start}: ${
      scopeRose
        ? `scope ${first.scope} to ${last.scope} items`
        : `scope ${last.scope} items`
    }, ${doneRose ? `done ${first.done} to ${last.done}` : `done ${last.done}`}.`,
  };
}

function Chart({ history, now }: { history: HistoryPoint[]; now: Date }) {
  const [ref, measured] = useMeasuredWidth();
  const g = burnUpGeometry(history, measured ?? DEFAULT_WIDTH);
  const { label, summary } = describeHistory(history, now);
  const lastScope = g.scope.at(-1);
  const lastDone = g.done.at(-1);
  const labelX = g.plotRight + 8;
  return (
    <>
      <div ref={ref}>
        <svg
          role="img"
          aria-label={label}
          width={g.width}
          height={g.height}
          viewBox={`0 0 ${g.width} ${g.height}`}
          className="block overflow-visible"
        >
          {g.ticks.slice(1).map((tick) => (
            <line
              key={tick.value}
              x1={g.left}
              x2={g.plotRight}
              y1={tick.y}
              y2={tick.y}
              strokeWidth={1}
              className="stroke-rule"
            />
          ))}
          <line
            x1={g.left}
            x2={g.plotRight}
            y1={g.bottom}
            y2={g.bottom}
            strokeWidth={1}
            className="stroke-border"
          />
          <g className="fill-muted-foreground text-2xs">
            {g.ticks.map((tick) => (
              <text
                key={tick.value}
                x={g.left - 6}
                y={tick.y + 4}
                textAnchor="end"
              >
                {tick.value}
              </text>
            ))}
            {g.xLabels.map((x) => (
              <text key={x.date} x={x.x} y={g.xLabelY} textAnchor={x.anchor}>
                {formatDate(x.date, now)}
              </text>
            ))}
          </g>
          <polygon
            points={points([
              ...g.done,
              [g.plotRight, g.bottom],
              [g.left, g.bottom],
            ])}
            className="fill-success-muted"
          />
          <polyline
            points={points(g.scope)}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            className="fill-none stroke-muted-foreground"
          />
          <polyline
            points={points(g.done)}
            strokeWidth={2}
            className="fill-none stroke-success"
          />
          {lastScope && (
            <circle
              cx={lastScope[0]}
              cy={lastScope[1]}
              r={3}
              strokeWidth={1.5}
              className="fill-background stroke-muted-foreground"
            />
          )}
          {lastDone && (
            <circle
              cx={lastDone[0]}
              cy={lastDone[1]}
              r={3}
              className="fill-success"
            />
          )}
          <g className="text-xs font-medium">
            <text
              x={labelX}
              y={g.endLabels.scope.y + 4}
              className="fill-muted-foreground"
            >
              {g.endLabels.scope.text}
            </text>
            <text
              x={labelX}
              y={g.endLabels.done.y + 4}
              className="fill-success"
            >
              {g.endLabels.done.text}
            </text>
          </g>
        </svg>
      </div>
      <p className="mt-1.5">{summary}</p>
      <p className="text-xs text-muted-foreground">
        Counts today's items by the day each joined the project and finished.
      </p>
    </>
  );
}

/**
 * Progress over time: items in scope (dashed) and done (solid, over an area) by day, from
 * the first day an item now in scope joined to today, fitted to its container's width.
 * A history of one day draws when it started in place of the chart.
 */
export function BurnUp({
  history,
  now,
  className,
}: {
  /** In date order, one point a day (a week, past 120 days), the last today. */
  history: HistoryPoint[];
  /** The viewer's clock, for the dates' year. */
  now: Date;
  className?: string;
}) {
  const headingId = useId();
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last) return null;
  return (
    <section aria-labelledby={headingId} className={className}>
      <AsideHeading id={headingId}>Progress over time</AsideHeading>
      {first.date === last.date ? (
        <p className="text-muted-foreground">
          {`Started ${formatDate(first.date, now)}. The chart draws from day two.`}
        </p>
      ) : (
        <Chart history={history} now={now} />
      )}
    </section>
  );
}
