import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
  type LucideIcon,
  PackageIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { KeyText } from "@/components/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WebItemType, WebProductRefView } from "@/lib/api-types";

/**
 * A single-choice filter menu, "All …" first with a check on the chosen row. As a chip
 * (the default): an outline trigger with a glyph and the chosen label, named by `label`.
 * With `fieldLabel`: that word above a full-width trigger, as the Filters sheet stacks
 * them, the chosen option's `before` beside its label. `onChange` gets Base UI's event
 * details as its second argument.
 */
export function FilterSelect<T extends string>({
  label,
  fieldLabel,
  allLabel,
  icon: Icon,
  options,
  value,
  onChange,
}: {
  label: string;
  fieldLabel?: string;
  allLabel: string;
  icon: LucideIcon;
  /** `before` and `after` flank the label in the menu; a chip's trigger shows the label alone. */
  options: { value: T; label: string; before?: ReactNode; after?: ReactNode }[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  const items: {
    value: T | null;
    label: string;
    before?: ReactNode;
    after?: ReactNode;
  }[] = [{ value: null, label: allLabel }, ...options];
  // a value gone from the options (a bot no longer listed) reads as the All label
  const chosenItem = (chosen: T | null) =>
    items.find((item) => item.value === chosen);
  return (
    <Select items={items} value={value} onValueChange={onChange}>
      {fieldLabel ? (
        <div className="flex flex-col gap-1.5">
          <SelectPrimitive.Label className="w-fit font-medium">
            {fieldLabel}
          </SelectPrimitive.Label>
          <SelectTrigger className="w-full">
            <SelectValue>
              {(chosen: T | null) => {
                const item = chosenItem(chosen);
                return item ? (
                  <>
                    {item.before}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </>
                ) : (
                  allLabel
                );
              }}
            </SelectValue>
          </SelectTrigger>
        </div>
      ) : (
        <SelectTrigger aria-label={label} className="shrink-0 font-medium">
          <Icon aria-hidden="true" className="size-3.5" />
          <SelectValue>
            {(chosen: T | null) => chosenItem(chosen)?.label ?? allLabel}
          </SelectValue>
        </SelectTrigger>
      )}
      {/* as wide as its widest item, titles included, inside the viewport */}
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="w-auto min-w-(--anchor-width) max-w-(--available-width)"
      >
        <SelectGroup>
          {items.map((item) => (
            <SelectItem
              key={item.value ?? ""}
              value={item.value}
              label={item.label}
              // the item's text part is shrink-0 in components/ui: let it give way, so a
              // long name truncates instead of running out of a viewport-wide menu
              className="*:first:min-w-0 *:first:shrink!"
            >
              {item.before}
              {item.before && " "}
              <span className="min-w-0 truncate">{item.label}</span>
              {item.after}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * Below lg, one Filters button in place of a row of filter chips; it opens a bottom
 * sheet titled Filters that stacks `children` (`FilterSelect`s with a `fieldLabel`),
 * which apply as they change. The primary button closes the sheet.
 */
export function FiltersSheet({
  activeCount,
  doneLabel,
  children,
  className,
}: {
  /** Filters in force, counted on the button. */
  activeCount: number;
  /** The primary button: "Show 12 events". */
  doneLabel: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={<Button variant="outline" className={className} />}
      >
        <SlidersHorizontalIcon data-icon="inline-start" aria-hidden="true" />
        Filters
        {activeCount > 0 && (
          <>
            {" "}
            <span className="font-normal text-muted-foreground">
              {activeCount} <span className="sr-only">in use</span>
            </span>
          </>
        )}
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="inset-x-0 top-auto bottom-0 max-w-none translate-none gap-5 rounded-none rounded-t-3xl p-4 ring-0 sm:max-w-none"
      >
        <DialogTitle className="text-lg font-semibold">Filters</DialogTitle>
        <div className="flex flex-col gap-4">{children}</div>
        <DialogClose render={<Button className="w-full" />}>
          {doneLabel}
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "All products" or one of `products`, key in mono before the name. Lists exactly the
 * products it is given: on a project page, the ones the viewer can see.
 */
export function ProductSelect({
  products,
  value,
  onChange,
  fieldLabel,
}: {
  products: WebProductRefView[];
  /** Set inside the Filters sheet: the word above the trigger. */
  fieldLabel?: string;
  /** A product key, or null for all products. */
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  return (
    <FilterSelect
      label="Filter by product"
      fieldLabel={fieldLabel}
      allLabel="All products"
      icon={PackageIcon}
      options={products.map((p) => ({
        value: p.key,
        label: p.name,
        before: <KeyText className="text-foreground">{p.key}</KeyText>,
      }))}
      value={value}
      onChange={(key) => onChange(key)}
    />
  );
}

const TYPE_OPTIONS: { value: WebItemType; label: string }[] = [
  { value: "issue", label: "Issues" },
  { value: "todo", label: "Todos" },
  { value: "note", label: "Notes" },
];

/** "All types", Issues, Todos or Notes. */
export function TypeSelect({
  value,
  onChange,
  fieldLabel,
}: {
  value: WebItemType | null;
  onChange: (type: WebItemType | null) => void;
  /** Set inside the Filters sheet: the word above the trigger. */
  fieldLabel?: string;
}) {
  return (
    <FilterSelect
      label="Filter by type"
      fieldLabel={fieldLabel}
      allLabel="All types"
      icon={ShapesIcon}
      options={TYPE_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
