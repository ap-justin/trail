import { type ComponentProps, useSyncExternalStore } from "react";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * The tabs that switch a page between its panes below 1024px; at 1024px and up every
 * pane shows and the strip is gone. Render inside a `Tabs` whose value is the shown pane.
 */
export function PaneTabs({
  panes,
  className,
}: {
  /** `[value, label]` per pane, in order. */
  panes: readonly (readonly [string, string])[];
  className?: string;
}) {
  return (
    <TabsList
      variant="line"
      aria-label="Show"
      className={cn(
        "w-full justify-start gap-4 rounded-none border-b p-0 px-4 lg:hidden",
        className,
      )}
    >
      {panes.map(([value, label]) => (
        <TabsTrigger
          key={value}
          value={value}
          className="min-w-11 flex-none px-0.5 font-normal text-muted-foreground group-data-horizontal/tabs:after:-bottom-px data-active:text-foreground"
        >
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

// the strip's lg:hidden breakpoint
const DESKTOP = "(min-width: 1024px)";

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const isDesktop = () => window.matchMedia(DESKTOP).matches;

/**
 * One pane: a tab panel that shows only while its tab is selected below 1024px. At 1024px
 * and up every pane shows, so the `hidden` and `inert` Base UI puts on an unselected panel
 * are lifted and the breakpoint hides it instead; with no tab there to name it, it drops
 * the panel's role, label and tab stop too.
 */
export function Pane({
  className,
  ...props
}: Omit<
  ComponentProps<typeof TabsContent>,
  "keepMounted" | "hidden" | "render"
>) {
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop);
  return (
    <TabsContent
      keepMounted
      hidden={false}
      inert={false}
      render={
        desktop
          ? ({
              role: _role,
              tabIndex: _tabIndex,
              "aria-labelledby": _labelledBy,
              ...rest
            }) => <div {...rest} />
          : undefined
      }
      className={cn(
        "flex-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:data-hidden:hidden",
        className,
      )}
      {...props}
    />
  );
}
