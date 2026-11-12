import { FolderIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { AppLink } from "@/components/app-link";
import { EmptyState, SkeletonBlock } from "@/components/states";
import { StatusIcon } from "@/components/status";
import { KeyText } from "@/components/text";
import type { SearchView } from "@/lib/api-types";
import { paths } from "@/lib/paths";

export type SearchResultsProps = {
  /** What the search box holds now. */
  query: string;
  /** The query `results` and `status` answer; while it trails `query` the panel shows loading. */
  answeredQuery: string;
  /** Visible projects and issues matching `answeredQuery`; null before the first answer. */
  results: Pick<SearchView, "issues" | "projects"> | null;
  status: "loading" | "error" | "ready";
};

// the popover surface, as the stock menus draw it; it scrolls inside whatever height
// the caller's flex-column slot allows
const panel =
  "flex min-h-0 flex-col overflow-y-auto overscroll-contain rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10";

const row =
  "flex h-8 items-center gap-2 rounded-md px-2 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-3 focus-visible:ring-ring/25 max-lg:h-10";

/**
 * The search box's results, drawn in the shell's `searchResults` slot at both widths:
 * one list of projects (folder glyph), then issues (status glyph), each a link reachable
 * by Tab from the box. Following one ends the search: the shell clears the box, so
 * there is no callback here.
 */
export function SearchResults({
  query,
  answeredQuery,
  results,
  status,
}: SearchResultsProps) {
  const shown =
    query.trim() !== answeredQuery.trim()
      ? "loading"
      : status === "ready"
        ? results
        : status;
  return (
    <div className={panel}>
      {/* one region across every state, so each change of outcome is announced */}
      <p role="status" className="sr-only">
        {announcement(shown)}
      </p>
      {shown === "loading" || shown === "error" || shown === null ? (
        <SearchResultsPlaceholder
          status={shown === "error" ? "error" : "loading"}
        />
      ) : (
        <SearchResultsBody results={shown} />
      )}
    </div>
  );
}

type Results = NonNullable<SearchResultsProps["results"]>;

function announcement(shown: Results | "loading" | "error" | null): string {
  if (shown === "loading" || shown === null) return "Loading";
  if (shown === "error") return "Couldn't search";
  const count = shown.projects.length + shown.issues.length;
  if (count === 0) return "No results";
  return count === 1 ? "1 result" : `${count} results`;
}

function SearchResultsPlaceholder({ status }: { status: "loading" | "error" }) {
  if (status === "error") {
    return (
      <EmptyState
        icon={TriangleAlertIcon}
        title="Couldn't search"
        description="Check your connection, then try again."
        className="py-4"
      />
    );
  }
  return (
    <div className="flex flex-col gap-2.5 p-2">
      <SkeletonBlock className="w-3/5" />
      <SkeletonBlock className="w-4/5" />
      <SkeletonBlock className="w-2/5" />
    </div>
  );
}

function SearchResultsBody({ results }: { results: Results }) {
  if (results.projects.length === 0 && results.issues.length === 0) {
    return (
      <EmptyState
        icon={SearchIcon}
        title="No results"
        description="Try another word."
        className="py-4"
      />
    );
  }
  return (
    <ul aria-label="Search results">
      {results.projects.map((project) => (
        <li key={project.key}>
          <AppLink
            href={paths.project(project.key)}
            // spans with no space between would be read as one word: "TRLtrail"
            aria-label={`${project.key} ${project.name}`}
            className={row}
          >
            <FolderIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <KeyText>{project.key}</KeyText>
            <span className="truncate">{project.name}</span>
          </AppLink>
        </li>
      ))}
      {results.issues.map((issue) => (
        <li key={issue.key}>
          <AppLink
            href={paths.issue(issue.key)}
            aria-label={[issue.key, issue.title, issue.sourceKey]
              .filter(Boolean)
              .join(" ")}
            className={row}
          >
            <StatusIcon status={issue.status} />
            <KeyText>{issue.key}</KeyText>
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            {issue.sourceKey && (
              <KeyText className="font-normal">{issue.sourceKey}</KeyText>
            )}
          </AppLink>
        </li>
      ))}
    </ul>
  );
}
