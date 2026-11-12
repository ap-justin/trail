import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleXIcon,
  type LucideIcon,
  MinusIcon,
  SignalHighIcon,
  SignalLowIcon,
  SignalMediumIcon,
} from "lucide-react";
import type { WebIssueRowView, WebProjectView } from "@/lib/api-types";
import { cn } from "@/lib/utils";

export type IssueStatus = WebIssueRowView["status"];
export type ProjectHealth = NonNullable<WebProjectView["health"]>;

const statuses: Record<
  IssueStatus,
  { label: string; icon: LucideIcon; ink: string }
> = {
  open: { label: "Open", icon: CircleIcon, ink: "text-muted-foreground" },
  in_progress: {
    label: "In progress",
    icon: CircleDotIcon,
    ink: "text-warning",
  },
  done: { label: "Done", icon: CircleCheckIcon, ink: "text-success" },
  canceled: {
    label: "Canceled",
    icon: CircleXIcon,
    ink: "text-muted-foreground",
  },
};

export function statusLabel(status: IssueStatus): string {
  return statuses[status].label;
}

/**
 * The status glyph alone. With `label` it is an image named for the status (an
 * icon-only column); without, it is decorative beside a word that names it.
 */
export function StatusIcon({
  status,
  label = false,
  className,
}: {
  status: IssueStatus;
  label?: boolean;
  className?: string;
}) {
  const { icon: Icon, ink, label: name } = statuses[status];
  return (
    <Icon
      className={cn("size-3.5 shrink-0", ink, className)}
      {...(label
        ? { role: "img", "aria-label": name }
        : { "aria-hidden": true })}
    />
  );
}

/** Glyph plus word, in the status's ink. Never wraps. */
export function StatusLabel({
  status,
  className,
}: {
  status: IssueStatus;
  className?: string;
}) {
  const { ink, label } = statuses[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs whitespace-nowrap",
        ink,
        className,
      )}
    >
      <StatusIcon status={status} />
      {label}
    </span>
  );
}

const healths: Record<ProjectHealth, { label: string; ink: string }> = {
  on_track: { label: "On track", ink: "text-success" },
  at_risk: { label: "At risk", ink: "text-warning" },
  off_track: { label: "Off track", ink: "text-destructive" },
};

/** A dot plus the health word. */
export function HealthPill({
  health,
  className,
}: {
  health: ProjectHealth;
  className?: string;
}) {
  const { ink, label } = healths[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.25 text-xs font-medium whitespace-nowrap",
        ink,
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.75 rounded-full bg-current" />
      {label}
    </span>
  );
}

type Priority = { label: string; icon: LucideIcon; muted: boolean };

const NONE: Priority = { label: "None", icon: MinusIcon, muted: true };
const priorities: Priority[] = [
  NONE,
  { label: "Urgent", icon: CircleAlertIcon, muted: false },
  { label: "High", icon: SignalHighIcon, muted: false },
  { label: "Medium", icon: SignalMediumIcon, muted: false },
  { label: "Low", icon: SignalLowIcon, muted: true },
];

// 0 to 4 by the schema; the index type still admits a miss
const priorityOf = (priority: number) => priorities[priority] ?? NONE;

export function priorityLabel(priority: number): string {
  return priorityOf(priority).label;
}

/**
 * Icon plus word; `iconOnly` (the 375 list) keeps the word as the icon's accessible
 * name. None (0) draws a dash, never a signal glyph.
 */
export function PriorityLabel({
  priority,
  iconOnly = false,
  className,
}: {
  priority: number;
  iconOnly?: boolean;
  className?: string;
}) {
  const { icon: Icon, label, muted } = priorityOf(priority);
  const ink = muted && "text-muted-foreground";
  if (iconOnly) {
    return (
      <Icon
        role="img"
        aria-label={label}
        className={cn("size-3.5 shrink-0", ink, className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.25 text-xs whitespace-nowrap",
        ink,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
