import {
  ActivityIcon,
  FolderIcon,
  type LucideIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { AppLink } from "@/components/app-link";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { paths } from "@/lib/paths";
import { cn } from "@/lib/utils";

// 28px at 1440, a 40px tap target below the desktop layout
const panelAction = "max-lg:h-10 max-lg:px-3.5";

/** The empty-state layout: icon, title, one line of help, an optional action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("gap-3 py-12", className)}>
      <EmptyHeader className="gap-1.5">
        {Icon && (
          <EmptyMedia className="mb-0 text-muted-foreground">
            <Icon aria-hidden="true" className="size-5" />
          </EmptyMedia>
        )}
        <EmptyTitle
          role="heading"
          aria-level={2}
          className="font-semibold tracking-normal"
        >
          {title}
        </EmptyTitle>
        <EmptyDescription className="max-w-75">{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** A failed load: warning glyph, the copy, and Try again. Announced when it appears. */
export function ErrorState({
  title,
  description,
  onRetry,
  className,
}: {
  title: string;
  description: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={className}>
      <EmptyState
        icon={TriangleAlertIcon}
        title={title}
        description={description}
        action={
          <Button
            variant="outline"
            size="sm"
            className={panelAction}
            onClick={onRetry}
          >
            Try again
          </Button>
        }
      />
    </div>
  );
}

/**
 * Missing page, issue or project, and any project the viewer can't see: one copy for
 * all, so a hidden project reads exactly like a missing one.
 */
export function NotFoundPanel({ className }: { className?: string }) {
  return (
    <Empty className={cn("gap-3 py-12", className)}>
      <EmptyHeader className="gap-1.5">
        <p
          aria-hidden="true"
          className="text-display font-semibold text-muted-foreground"
        >
          404
        </p>
        <EmptyTitle
          role="heading"
          aria-level={1}
          className="font-semibold tracking-normal"
        >
          Page not found
        </EmptyTitle>
        <EmptyDescription className="max-w-75">
          This page doesn't exist, or you don't have access to it.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <AppLink
          href={paths.feed}
          className={cn(buttonVariants({ size: "sm" }), panelAction)}
        >
          Go to feed
        </AppLink>
      </EmptyContent>
    </Empty>
  );
}

export function FeedEmpty() {
  return (
    <EmptyState
      icon={ActivityIcon}
      title="No activity yet"
      description="When bots create issues, comment or post status updates, it shows up here as it happens."
    />
  );
}

/** Nothing under the feed filters: say so, and offer them all back. */
export function FeedFilterEmpty({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      icon={SearchIcon}
      title="Nothing matches these filters"
      description="Try other filters, or clear them to see all activity."
      action={
        <Button
          variant="outline"
          size="sm"
          className={panelAction}
          onClick={onClear}
        >
          Clear filters
        </Button>
      }
    />
  );
}

/** A member the owner has not added to any product: nothing can appear until they do. */
export function FeedNoProducts() {
  return (
    <EmptyState
      icon={PackageIcon}
      title="No products yet"
      description="Ask the owner to add you to a product."
    />
  );
}

export function FeedError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Couldn't load the feed"
      description="Check your connection, then try again."
      onRetry={onRetry}
    />
  );
}

/** A placeholder block that holds still: skeletons in trail never pulse. */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <Skeleton
      aria-hidden="true"
      className={cn("h-2.5 animate-none rounded-sm", className)}
    />
  );
}

/** Wraps skeleton blocks so assistive tech hears one "Loading" instead of nothing. */
export function LoadingRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">Loading</span>
      {children}
    </div>
  );
}

export function ItemListEmpty({
  productKey,
  onNewIssue,
}: {
  productKey: string;
  onNewIssue: () => void;
}) {
  return (
    <EmptyState
      icon={FolderIcon}
      title={`No items in ${productKey} yet`}
      description="Bots file issues here. You can file one too."
      action={
        <Button size="sm" className={panelAction} onClick={onNewIssue}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          New issue
        </Button>
      }
    />
  );
}

export function IssueListError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Couldn't load issues"
      description="Check your connection, then try again."
      onRetry={onRetry}
    />
  );
}

/** A person given no products yet is pointed at the owner; the owner sees where products come from. */
export function ProductsEmpty({
  ownerName,
  isOwner,
}: {
  ownerName: string;
  isOwner: boolean;
}) {
  return (
    <EmptyState
      icon={PackageIcon}
      title="No products yet"
      description={
        isOwner
          ? "Products that bots create show up here."
          : `Ask ${ownerName} to give you access to a product.`
      }
    />
  );
}

export function ProductsError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Couldn't load products"
      description="Check your connection, then try again."
      onRetry={onRetry}
    />
  );
}

export function ProjectsError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Couldn't load projects"
      description="Check your connection, then try again."
      onRetry={onRetry}
    />
  );
}

export function IssueError({
  issueKey,
  onRetry,
}: {
  issueKey: string;
  onRetry: () => void;
}) {
  return (
    <ErrorState
      title={`Couldn't load ${issueKey}`}
      description="Something went wrong on our side. Try again."
      onRetry={onRetry}
    />
  );
}

/** Rows of key, title and a trailing column: the issue list and the projects table. */
export function ListSkeleton({ className }: { className?: string }) {
  return (
    <LoadingRegion className={cn("flex flex-col gap-3 py-4", className)}>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-2.5">
          <SkeletonBlock className="w-12" />
          <SkeletonBlock className="flex-1" />
          <SkeletonBlock className="w-15" />
        </div>
      ))}
    </LoadingRegion>
  );
}

/** The title, the key line, then the description. */
export function IssueSkeleton({ className }: { className?: string }) {
  return (
    <LoadingRegion className={cn("flex flex-col gap-3", className)}>
      <SkeletonBlock className="h-4 w-3/5" />
      <SkeletonBlock className="w-7/20" />
      <SkeletonBlock className="w-9/10" />
      <SkeletonBlock className="w-4/5" />
      <SkeletonBlock className="w-7/10" />
    </LoadingRegion>
  );
}
