import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  LogOutIcon,
  type LucideIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ActorAvatar } from "@/components/actor";
import { AppLink, type AppLinkProps } from "@/components/app-link";
import { KeyText, Wordmark } from "@/components/text";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { WebProjectRefView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { type ThemeChoice, themeChoices, themeLabels } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type ShellViewer = {
  name: string;
  /** The GitHub login, without the @. */
  login: string;
  isOwner: boolean;
  photoUrl: string | null;
};

export type ShellSection = "feed" | "projects" | "people" | "account";

export type AppShellProps = {
  viewer: ShellViewer;
  /** The projects the viewer can see, as key plus name. */
  projects: WebProjectRefView[];
  /** The nav item for the current page; null on pages under none (an issue, Not found). */
  section: ShellSection | null;
  /** The project the page sits in: a project page's own key, or an issue's project. */
  projectKey?: string;
  /** The page title or breadcrumb: in the top bar at 1440, under it at 375. Null draws no heading. */
  heading: ReactNode;
  /**
   * `breadcrumb` draws the heading as a Breadcrumb nav rather than an h1, for a page whose
   * content carries its own h1 (an issue: the breadcrumb here, the title in the page).
   */
  headingKind?: "title" | "breadcrumb";
  /** Beside the heading, such as the feed's Live indicator. */
  headingAccessory?: ReactNode;
  /**
   * Below 1024px, a back chevron to `href` (named `label`, such as "Back to trail") with the
   * heading beside it in the top bar, in place of the wordmark and the heading row.
   */
  back?: { href: string; label: string };
  /** The search box's text, when the caller owns it; the shell keeps its own otherwise. */
  searchValue?: string;
  /** Every change of the search text: typing, Escape (""), following a result (""). */
  onSearch: (query: string) => void;
  /** Drawn under the search box while non-null: `SearchResults`. */
  searchResults?: ReactNode;
  onNewIssue: () => void;
  onSignOut: () => void;
  children: ReactNode;
};

type NavItem = {
  section: ShellSection;
  label: string;
  href: string;
  icon: LucideIcon;
};

type Current = AppLinkProps["aria-current"];

// A project's own row marks its page, not Projects; under a project (an issue) the row and
// the Projects tab mark where the page sits.
function sectionCurrent(
  item: ShellSection,
  section: ShellSection | null,
  projectKey: string | undefined,
  { tab }: { tab: boolean },
): Current {
  if (item === section) return tab || !projectKey ? "page" : undefined;
  return tab && item === "projects" && projectKey ? "location" : undefined;
}

function projectCurrent(
  key: string,
  section: ShellSection | null,
  projectKey: string | undefined,
): Current {
  if (key !== projectKey) return undefined;
  return section === "projects" ? "page" : "location";
}

function navItems(isOwner: boolean, withAccount: boolean): NavItem[] {
  return [
    { section: "feed", label: "Feed", href: paths.feed, icon: ActivityIcon },
    {
      section: "projects",
      label: "Projects",
      href: paths.projects,
      icon: FolderIcon,
    },
    ...(isOwner
      ? [
          {
            section: "people",
            label: "People",
            href: paths.people,
            icon: UsersIcon,
          } as const,
        ]
      : []),
    ...(withAccount
      ? [
          {
            section: "account",
            label: "Account",
            href: paths.account,
            icon: UserIcon,
          } as const,
        ]
      : []),
  ];
}

// state carried in ink and ground, never weight, so a label doesn't reflow when it turns on
const sideItem =
  "flex h-7.5 items-center gap-2 rounded-md px-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/25 aria-[current]:bg-muted aria-[current]:text-foreground";

function Sidebar({
  viewer,
  projects,
  section,
  projectKey,
  onSignOut,
}: Pick<
  AppShellProps,
  "viewer" | "projects" | "section" | "projectKey" | "onSignOut"
>) {
  const projectsLabel = useId();
  return (
    <aside className="sticky top-0 hidden h-dvh w-58 shrink-0 flex-col gap-0.5 border-r px-2 py-3 lg:flex">
      <Wordmark className="flex h-8 items-center px-2" />
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {navItems(viewer.isOwner, false).map((item) => (
          <AppLink
            key={item.section}
            href={item.href}
            aria-current={sectionCurrent(item.section, section, projectKey, {
              tab: false,
            })}
            className={sideItem}
          >
            <item.icon aria-hidden="true" className="size-4" />
            {item.label}
          </AppLink>
        ))}
      </nav>
      {projects.length > 0 && (
        // scrolls on its own so a long list never pushes the account menu off-screen; the
        // inline padding keeps the links' focus rings inside the clip
        <nav
          aria-labelledby={projectsLabel}
          className="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1 pb-1"
        >
          <h2
            id={projectsLabel}
            className="px-2 pt-3.5 pb-1 text-2xs font-normal text-muted-foreground"
          >
            Projects
          </h2>
          {projects.map((project) => {
            const current = projectCurrent(project.key, section, projectKey);
            return (
              <AppLink
                key={project.key}
                href={paths.project(project.key)}
                aria-current={current}
                className={sideItem}
              >
                <KeyText className={cn(current && "text-current")}>
                  {project.key}
                </KeyText>{" "}
                <span className="truncate">{project.name}</span>
              </AppLink>
            );
          })}
        </nav>
      )}
      <div className="mt-auto border-t pt-2.5">
        <AccountMenu viewer={viewer} onSignOut={onSignOut} />
      </div>
    </aside>
  );
}

function AccountMenu({
  viewer,
  onSignOut,
}: Pick<AppShellProps, "viewer" | "onSignOut">) {
  const { choice, setChoice } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${viewer.name}`}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/25 aria-expanded:bg-muted"
      >
        <ActorAvatar
          actor={{
            name: viewer.name,
            kind: "human",
            photoUrl: viewer.photoUrl,
          }}
          loading="eager"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{viewer.name}</span>
          {viewer.isOwner ? (
            <span className="text-2xs text-muted-foreground">Owner</span>
          ) : (
            <KeyText className="truncate text-2xs font-normal">
              @{viewer.login}
            </KeyText>
          )}
        </span>
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="rounded-xl">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-2xs font-normal">
            Theme
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={choice}
            onValueChange={(value: ThemeChoice) => setChoice(value)}
          >
            {themeChoices.map((option) => (
              <DropdownMenuRadioItem
                key={option}
                value={option}
                className="h-8"
              >
                {themeLabels[option]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="h-8" onClick={onSignOut}>
          <LogOutIcon aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The box and its results slot, as one search landmark that Escape and a followed result
 * end. The results hide on a press outside the landmark or focus moving out of it, and come
 * back when the box takes focus again, query intact.
 */
function SearchBox({
  query,
  onQueryChange,
  results,
  resultsClassName,
  onEnd,
  inputRef,
  autoFocus = false,
  className,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  results: ReactNode;
  resultsClassName?: string;
  onEnd: (how: "escape" | "result") => void;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const landmark = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!landmark.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <search
      ref={landmark}
      className={cn("relative", className)}
      onBlur={(event) => {
        // null is Safari pressing a result (links take no focus on click) as well as a press
        // on nothing focusable; the pointerdown listener decides those, so the click lands
        const to = event.relatedTarget;
        if (to && !event.currentTarget.contains(to)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onEnd("escape");
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a")) {
          onEnd("result");
        }
      }}
    >
      <div className="relative">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="search"
          aria-label="Search issues"
          placeholder="Search issues"
          className="pl-7.5 max-lg:h-10"
          // the 375 box opens on a tap of the search button, so focus follows that tap
          autoFocus={autoFocus}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setOpen(true);
            onQueryChange(event.currentTarget.value);
          }}
        />
      </div>
      {open && results && <div className={resultsClassName}>{results}</div>}
    </search>
  );
}

function ShellHeading({
  kind,
  className,
  children,
}: {
  kind: "title" | "breadcrumb";
  className: string;
  children: ReactNode;
}) {
  return kind === "breadcrumb" ? (
    <nav aria-label="Breadcrumb" className={className}>
      {children}
    </nav>
  ) : (
    <h1 className={className}>{children}</h1>
  );
}

function TabBar({
  viewer,
  section,
  projectKey,
}: Pick<AppShellProps, "viewer" | "section" | "projectKey">) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-10 flex h-14 border-t bg-background lg:hidden"
    >
      {navItems(viewer.isOwner, true).map((item) => (
        <AppLink
          key={item.section}
          href={item.href}
          aria-current={sectionCurrent(item.section, section, projectKey, {
            tab: true,
          })}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:ring-inset aria-[current]:text-foreground"
        >
          <item.icon aria-hidden="true" className="size-4" />
          {item.label}
        </AppLink>
      ))}
    </nav>
  );
}

/**
 * The signed-in frame. At 1024px and up: a 232px sidebar and a 48px top bar. Below:
 * the top bar with icon buttons, the heading under it, and a 56px bottom tab bar.
 * The switch is CSS only.
 */
export function AppShell({
  viewer,
  projects,
  section,
  projectKey,
  heading,
  headingKind = "title",
  headingAccessory,
  back,
  searchValue,
  onSearch,
  searchResults,
  onNewIssue,
  onSignOut,
  children,
}: AppShellProps) {
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const mobileSearchId = useId();
  const [ownQuery, setOwnQuery] = useState("");
  const query = searchValue ?? ownQuery;
  const desktopInput = useRef<HTMLInputElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);

  const changeQuery = (next: string) => {
    setOwnQuery(next);
    onSearch(next);
  };

  // the search ends on Escape or a followed result, so the box never keeps a stale query
  const endSearch = (how: "escape" | "result") => {
    changeQuery("");
    if (mobileSearchOpen) {
      setMobileSearchOpen(false);
      if (how === "escape") mobileToggle.current?.focus();
    } else if (how === "escape") {
      // the results may have held focus; they're gone now
      desktopInput.current?.focus();
    }
  };

  return (
    <div className="flex min-h-dvh">
      <Sidebar
        viewer={viewer}
        projects={projects}
        section={section}
        projectKey={projectKey}
        onSignOut={onSignOut}
      />
      <div className="flex min-w-0 flex-1 flex-col pb-14 lg:pb-0">
        <header className="sticky top-0 z-10 border-b bg-background">
          <div className="flex h-12 items-center gap-1 pr-2 pl-4 lg:gap-3 lg:px-5">
            {back ? (
              <div className="flex min-w-0 flex-1 items-center gap-1 lg:hidden">
                <AppLink
                  href={back.href}
                  aria-label={back.label}
                  className="grid size-10 shrink-0 place-items-center rounded-md outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/25"
                >
                  <ChevronLeftIcon aria-hidden="true" className="size-4" />
                </AppLink>
                {heading != null && (
                  <ShellHeading
                    kind={headingKind}
                    className="truncate font-medium"
                  >
                    {heading}
                  </ShellHeading>
                )}
              </div>
            ) : (
              <Wordmark className="flex-1 lg:hidden" />
            )}
            <div className="hidden min-w-0 flex-1 items-center gap-2 lg:flex">
              {heading != null && (
                <ShellHeading
                  kind={headingKind}
                  className="truncate font-medium"
                >
                  {heading}
                </ShellHeading>
              )}
              {headingAccessory}
            </div>
            <SearchBox
              query={query}
              onQueryChange={changeQuery}
              results={searchResults}
              // the window under the 48px bar, less a gap at its foot
              resultsClassName="absolute top-full right-0 mt-1 flex max-h-[calc(100dvh-var(--spacing)*14)] w-100 flex-col"
              onEnd={endSearch}
              inputRef={desktopInput}
              className="hidden w-65 lg:block"
            />
            <Button className="hidden lg:inline-flex" onClick={onNewIssue}>
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              New issue
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-10 lg:hidden"
              ref={mobileToggle}
              aria-label="Search"
              aria-expanded={mobileSearchOpen}
              aria-controls={mobileSearchId}
              onClick={() => setMobileSearchOpen((open) => !open)}
            >
              <SearchIcon aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-10 lg:hidden"
              aria-label="New issue"
              onClick={onNewIssue}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </div>
          {mobileSearchOpen && (
            <div id={mobileSearchId} className="px-4 pb-3 lg:hidden">
              <SearchBox
                query={query}
                onQueryChange={changeQuery}
                results={searchResults}
                // clear of the 48px bar, the 40px box, this sheet's padding and the 56px tab bar
                resultsClassName="mt-1 flex max-h-[calc(100dvh-var(--spacing)*40)] flex-col"
                onEnd={endSearch}
                autoFocus
              />
            </div>
          )}
        </header>
        {heading != null && !back && (
          <div className="flex items-center gap-2 px-4 pt-3 lg:hidden">
            <ShellHeading kind={headingKind} className="font-medium">
              {heading}
            </ShellHeading>
            {headingAccessory}
          </div>
        )}
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <TabBar viewer={viewer} section={section} projectKey={projectKey} />
    </div>
  );
}
