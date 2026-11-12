import { FolderIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { AppLink } from "@/components/app-link";
import { EmptyState, LoadingRegion, SkeletonBlock } from "@/components/states";
import { StatusIcon } from "@/components/status";
import { KeyText } from "@/components/text";
import type { SearchView } from "@/lib/api-types";
import { paths } from "@/lib/paths";

export type SearchResultsProps = {
  /** Visible projects and issues matching the query; null before the first answer. */
  results: Pick<SearchView, "issues" | "projects"> | null;
  status: "loading" | "error" | "ready";
};

// the popover surface, as the stock menus draw it
const panel =
  "rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10";

const row =
  "flex h-8 items-center gap-2 rounded-md px-2 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-3 focus-visible:ring-ring/25 max-lg:h-10";

/**
 * The search box's results, drawn in the shell's `searchResults` slot at both widths:
 * one list of projects (folder glyph), then issues (status glyph), each a link reachable
 * by Tab from the box. Following one ends the search: the shell clears the box, so
 * there is no callback here.
 */
export function SearchResults(props: SearchResultsProps) {
  return (
    <div className={panel}>
      <SearchResultsBody {...props} />
    </div>
  );
}

function SearchResultsBody({ results, status }: SearchResultsProps) {
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
  if (status === "loading" || !results) {
    return (
      <LoadingRegion className="flex flex-col gap-2.5 p-2">
        <SkeletonBlock className="w-3/5" />
        <SkeletonBlock className="w-4/5" />
        <SkeletonBlock className="w-2/5" />
      </LoadingRegion>
    );
  }
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
