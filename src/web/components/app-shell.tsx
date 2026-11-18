import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  LogOutIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PackageIcon,
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
import { Logo } from "@/components/logo";
import { KeyPill, KeyText } from "@/components/text";
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
import type { WebProductRefView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { type ThemeChoice, themeChoices, themeLabels } from "@/lib/theme";
import { cn } from "@/lib/utils";

export type ShellViewer = {
  name: string;
  /** `@` and the GitHub login, or the email address of a person who signs in by email. */
  handle: string;
  isOwner: boolean;
  photoUrl: string | null;
};

export type ShellSection =
  | "feed"
  | "products"
  | "projects"
  | "people"
  | "messages"
  | "account";

export type AppShellProps = {
  viewer: ShellViewer;
  /** The products the viewer can see, as key plus name. */
  products: WebProductRefView[];
  /** The nav item for the current page; null on pages under none (an item, Not found). */
  section: ShellSection | null;
  /** The product the page sits in: a product page's own key, or an item's product. */
  productKey?: string;
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

// A product's own row marks its page, not Products; under a product (an item) the row and
// the Products tab mark where the page sits.
function sectionCurrent(
  item: ShellSection,
  section: ShellSection | null,
  productKey: string | undefined,
  { tab }: { tab: boolean },
): Current {
  if (item === section) return tab || !productKey ? "page" : undefined;
  return tab && item === "products" && productKey ? "location" : undefined;
}

function productCurrent(
  key: string,
  section: ShellSection | null,
  productKey: string | undefined,
): Current {
  if (key !== productKey) return undefined;
  return section === "products" ? "page" : "location";
}

function navItems(isOwner: boolean, withAccount: boolean): NavItem[] {
  return [
    { section: "feed", label: "Feed", href: paths.feed, icon: ActivityIcon },
    {
      section: "products",
      label: "Products",
      href: paths.products,
      icon: PackageIcon,
    },
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
          {
            section: "messages",
            label: "Messages",
            href: paths.messages,
            icon: MessagesSquareIcon,
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
  "flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current]:bg-accent aria-[current]:text-foreground";

function Sidebar({
  viewer,
  products,
  section,
  productKey,
  onSignOut,
}: Pick<
  AppShellProps,
  "viewer" | "products" | "section" | "productKey" | "onSignOut"
>) {
  const productsLabel = useId();
  return (
    <aside className="sticky top-0 hidden h-dvh w-58 shrink-0 flex-col gap-0.5 px-2 py-3 lg:flex">
      <Logo className="h-8 px-2" />
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {navItems(viewer.isOwner, false).map((item) => (
          <AppLink
            key={item.section}
            href={item.href}
            aria-current={sectionCurrent(item.section, section, productKey, {
              tab: false,
            })}
            className={sideItem}
          >
            <item.icon aria-hidden="true" className="size-4" />
            {item.label}
          </AppLink>
        ))}
      </nav>
      {products.length > 0 && (
        // scrolls on its own so a long list never pushes the account menu off-screen; the
        // inline padding keeps the links' focus rings inside the clip
        <nav
          aria-labelledby={productsLabel}
          className="-mx-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto px-1 pb-1"
        >
          <h2
            id={productsLabel}
            className="px-2 pt-3.5 pb-1 text-xs font-normal text-muted-foreground"
          >
            Products
          </h2>
          {products.map((product) => {
            const current = productCurrent(product.key, section, productKey);
            return (
              <AppLink
                key={product.key}
                href={paths.product(product.key)}
                aria-current={current}
                className={sideItem}
              >
                <span className="truncate">{product.name}</span>{" "}
                <KeyPill className={cn(current && "text-current")}>
                  {product.key}
                </KeyPill>
              </AppLink>
            );
          })}
        </nav>
      )}
      <div className="mt-auto pt-2.5">
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
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-expanded:bg-accent"
      >
        <ActorAvatar
          actor={{
            name: viewer.name,
            kind: "human",
            photoUrl: viewer.photoUrl,
          }}
          // the sidebar is display:none below lg, and a lazy img that never renders never fetches
          loading="lazy"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{viewer.name}</span>
          {viewer.isOwner ? (
            <span className="text-xs text-muted-foreground">Owner</span>
          ) : (
            <KeyText className="truncate font-normal">{viewer.handle}</KeyText>
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
          className="pl-7.5"
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

/**
 * The heading in the top bar never clips, as a link in it draws its focus ring outside its
 * box: a plain title truncates in its own span, a composed heading truncates its parts.
 */
const barHeadingClass = "flex min-w-0 font-medium";

function TabBar({
  viewer,
  section,
  productKey,
}: Pick<AppShellProps, "viewer" | "section" | "productKey">) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-10 flex h-14 bg-frame lg:hidden"
    >
      {navItems(viewer.isOwner, true).map((item) => (
        // sized to the label with the leftover shared, not equal shares: six equal tabs at
        // 320px are narrower than "Messages", so labels would run together
        <AppLink
          key={item.section}
          href={item.href}
          aria-current={sectionCurrent(item.section, section, productKey, {
            tab: true,
          })}
          className="group flex min-w-11 flex-auto flex-col rounded-md py-1 text-xs text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current]:text-foreground"
        >
          {/* the link keeps the bar's full height as its tap area; the current background is inset on this inner surface */}
          <span className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 group-aria-[current]:bg-accent">
            <item.icon aria-hidden="true" className="size-4" />
            {item.label}
          </span>
        </AppLink>
      ))}
    </nav>
  );
}

/**
 * The signed-in frame. At 1024px and up: a 232px sidebar and a 48px top bar on the frame
 * tint, holding the page on a sheet inset 8px from the right and bottom. Below: the sheet is
 * the screen, between the top bar with icon buttons and a 56px bottom tab bar, with the
 * heading at its head. The switch is CSS only.
 */
export function AppShell({
  viewer,
  products,
  section,
  productKey,
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

  const barHeading =
    typeof heading === "string" ? (
      <span className="truncate">{heading}</span>
    ) : (
      heading
    );

  return (
    <div className="flex min-h-dvh bg-frame">
      <Sidebar
        viewer={viewer}
        products={products}
        section={section}
        productKey={productKey}
        onSignOut={onSignOut}
      />
      <div className="flex min-w-0 flex-1 flex-col pb-14 lg:pb-0">
        <header className="sticky top-0 z-10 bg-frame">
          <div className="flex h-12 items-center gap-1 pr-1 pl-4 lg:grid lg:grid-cols-[1fr_--spacing(105)_1fr] lg:gap-3 lg:pr-3 lg:pl-5">
            {back ? (
              <div className="flex min-w-0 flex-1 items-center gap-1 lg:hidden">
                <AppLink
                  href={back.href}
                  aria-label={back.label}
                  className="grid size-11 shrink-0 place-items-center rounded-md hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <ChevronLeftIcon aria-hidden="true" className="size-4" />
                </AppLink>
                {heading != null && (
                  <ShellHeading kind={headingKind} className={barHeadingClass}>
                    {barHeading}
                  </ShellHeading>
                )}
              </div>
            ) : (
              <Logo className="flex-1 lg:hidden" />
            )}
            <div className="hidden min-w-0 flex-1 items-center gap-2 lg:flex">
              {heading != null && (
                <ShellHeading kind={headingKind} className={barHeadingClass}>
                  {barHeading}
                </ShellHeading>
              )}
              {headingAccessory}
            </div>
            <SearchBox
              query={query}
              onQueryChange={changeQuery}
              results={searchResults}
              // the window under the 48px bar, less a gap at its foot
              resultsClassName="absolute inset-x-0 top-full mt-1 flex max-h-[calc(100dvh-var(--spacing)*14)] flex-col"
              onEnd={endSearch}
              inputRef={desktopInput}
              className="hidden lg:block"
            />
            <Button
              className="hidden justify-self-end lg:inline-flex"
              onClick={onNewIssue}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              New issue
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              ref={mobileToggle}
              aria-label="Search"
              aria-expanded={mobileSearchOpen}
              aria-controls={mobileSearchId}
              onClick={() => setMobileSearchOpen((open) => !open)}
            >
              <SearchIcon aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              className="lg:hidden"
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
                // clear of the 48px bar, the 44px box, this sheet's padding and the 56px tab bar
                resultsClassName="mt-1 flex max-h-[calc(100dvh-var(--spacing)*41)] flex-col"
                onEnd={endSearch}
                autoFocus
              />
            </div>
          )}
        </header>
        <div className="flex min-w-0 flex-1 flex-col bg-background lg:mr-2 lg:mb-2 lg:overflow-clip lg:rounded-3xl lg:border">
          {heading != null && !back && (
            <div className="flex items-center gap-2 px-4 pt-3 lg:hidden">
              <ShellHeading
                kind={headingKind}
                className="text-base font-medium"
              >
                {heading}
              </ShellHeading>
              {headingAccessory}
            </div>
          )}
          <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </div>
      <TabBar viewer={viewer} section={section} productKey={productKey} />
    </div>
  );
}
