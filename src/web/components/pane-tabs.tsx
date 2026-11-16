import type { ComponentProps } from "react";
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
        "w-full justify-start gap-4 rounded-none border-b p-0 px-4 group-data-horizontal/tabs:h-10 lg:hidden",
        className,
      )}
    >
      {panes.map(([value, label]) => (
        <TabsTrigger
          key={value}
          value={value}
          className="h-10 min-w-10 flex-none px-0.5 font-normal text-muted-foreground group-data-horizontal/tabs:after:-bottom-px data-active:text-foreground"
        >
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/**
 * One pane: a tab panel that shows only while its tab is selected below 1024px. At 1024px
 * and up every pane shows, so the `hidden` and `inert` Base UI puts on an unselected panel
 * are lifted and the breakpoint hides it instead.
 */
export function Pane({
  className,
  ...props
}: Omit<ComponentProps<typeof TabsContent>, "keepMounted" | "hidden">) {
  return (
    <TabsContent
      keepMounted
      hidden={false}
      inert={false}
      className={cn(
        "flex-none rounded-sm focus-visible:ring-3 focus-visible:ring-ring/25 max-lg:data-hidden:hidden",
        className,
      )}
      {...props}
    />
  );
}
