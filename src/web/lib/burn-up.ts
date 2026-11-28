/** A day of a project's progress history: cumulative, at the end of a UTC day. */
export type HistoryPoint = { date: string; scope: number; done: number };

export type Point = [x: number, y: number];

export type BurnUpGeometry = {
  width: number;
  height: number;
  /** The plot's edges: the y axis, the lines' last day, the top gridline, the baseline. */
  left: number;
  plotRight: number;
  top: number;
  bottom: number;
  y: (value: number) => number;
  ticks: { value: number; y: number }[];
  scope: Point[];
  done: Point[];
  xLabels: { date: string; x: number; anchor: "start" | "middle" | "end" }[];
  xLabelY: number;
  endLabels: { scope: EndLabel; done: EndLabel };
};

type EndLabel = { text: string; y: number };

// the 520 frame: gridlines from y 8 to the baseline at 168, dates under it at 184
const HEIGHT = 188;
const TOP = 8;
const BOTTOM = 168;
const X_LABEL_Y = 184;
// Geist at 12px medium, a figure or letter at most this wide: sizes the gutters without measuring
const LABEL_CHAR = 7;
const LABEL_GAP = 8;
// two end labels' baselines at least this far apart, so 12px labels never overlap
const LABEL_SPACING = 14;
const DAY = 86_400_000;

/** Whole days since the epoch for a `YYYY-MM-DD`. */
function dayNumber(ymd: string): number {
  const [year = 0, month = 1, day = 1] = ymd.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY;
}

function ymdOf(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

// tenths of a power of ten: 1, 1.2, 1.4 … 10
const NICE_TENTHS = [10, 12, 14, 16, 20, 25, 30, 40, 50, 60, 80, 100];

/** The y axis's top: the least round number at or above `value` whose half is whole, for the 0 · half · max ticks. */
export function niceMax(value: number): number {
  if (value <= 1) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const tenths of NICE_TENTHS) {
    const candidate = (tenths * magnitude) / 10;
    if (candidate >= value && Number.isInteger(candidate / 2)) return candidate;
  }
  return 2 * magnitude * 10;
}

/**
 * Where everything in the burn-up chart sits at `width`: a pure function of the history,
 * so the drawing is tested without layout. `history` is in date order with two or more days.
 */
export function burnUpGeometry(
  history: HistoryPoint[],
  width: number,
): BurnUpGeometry {
  const first = history[0];
  const last = history.at(-1);
  const firstDay = first ? dayNumber(first.date) : 0;
  const lastDay = last ? dayNumber(last.date) : 0;
  const max = niceMax(Math.max(0, ...history.map((p) => p.scope)));

  const labels = {
    scope: `Scope ${last?.scope ?? 0}`,
    done: `Done ${last?.done ?? 0}`,
  };
  const left = Math.max(28, 8 + LABEL_CHAR * String(max).length);
  const plotRight =
    width -
    LABEL_GAP -
    LABEL_CHAR * Math.max(labels.scope.length, labels.done.length);

  const span = Math.max(1, lastDay - firstDay);
  const x = (day: number) =>
    left + ((day - firstDay) / span) * (plotRight - left);
  const y = (value: number) => BOTTOM - (value / max) * (BOTTOM - TOP);

  const scope = history.map((p): Point => [x(dayNumber(p.date)), y(p.scope)]);
  const done = history.map((p): Point => [x(dayNumber(p.date)), y(p.done)]);

  const xLabels: BurnUpGeometry["xLabels"] = [
    { date: ymdOf(firstDay), x: left, anchor: "start" },
  ];
  if (lastDay - firstDay >= 2) {
    const middle = Math.floor((firstDay + lastDay) / 2);
    xLabels.push({ date: ymdOf(middle), x: x(middle), anchor: "middle" });
  }
  xLabels.push({ date: ymdOf(lastDay), x: plotRight, anchor: "end" });

  let scopeY = y(last?.scope ?? 0);
  let doneY = y(last?.done ?? 0);
  if (doneY - scopeY < LABEL_SPACING) {
    const mid = (scopeY + doneY) / 2;
    scopeY = mid - LABEL_SPACING / 2;
    doneY = mid + LABEL_SPACING / 2;
  }

  return {
    width,
    height: HEIGHT,
    left,
    plotRight,
    top: TOP,
    bottom: BOTTOM,
    y,
    ticks: [0, max / 2, max].map((value) => ({ value, y: y(value) })),
    scope,
    done,
    xLabels,
    xLabelY: X_LABEL_Y,
    endLabels: {
      scope: { text: labels.scope, y: scopeY },
      done: { text: labels.done, y: doneY },
    },
  };
}
