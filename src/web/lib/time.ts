// All formats are in the viewer's time zone and en-US month names, as drawn.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const monthDayYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** `Nov 10`, or `Nov 10, 2025` outside the current year. */
export function formatDay(date: Date, now: Date): string {
  return date.getFullYear() === now.getFullYear()
    ? monthDay.format(date)
    : monthDayYear.format(date);
}

/** `just now` under a minute, `2m` under an hour, `1h` the same day, then `Nov 10`. */
export function formatRelative(iso: string, now: Date): string {
  const date = new Date(iso);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (isSameDay(date, now)) return `${Math.floor(elapsed / HOUR)}h`;
  return formatDay(date, now);
}

/** `Nov 10, 14:05`: 24-hour, no year. */
export function formatAbsolute(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${monthDay.format(date)}, ${hh}:${mm}`;
}

/** A feed day header: `Today`, `Yesterday`, then `Nov 10`. */
export function formatDayHeader(iso: string, now: Date): string {
  const date = new Date(iso);
  if (isSameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return "Yesterday";
  return formatDay(date, now);
}

/** A local-calendar-day key for grouping rows under one header. */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
