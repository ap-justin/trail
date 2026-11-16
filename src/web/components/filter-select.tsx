import { type LucideIcon, PackageIcon } from "lucide-react";
import type { ReactNode } from "react";
import { KeyText } from "@/components/text";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WebProductRefView } from "@/lib/api-types";

/**
 * A single-choice filter menu: an outline trigger with a glyph and the chosen label,
 * "All …" first in the menu with a check on the chosen row. `onChange` gets Base UI's
 * event details as its second argument.
 */
export function FilterSelect<T extends string>({
  label,
  allLabel,
  icon: Icon,
  options,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  icon: LucideIcon;
  /** `before` and `after` flank the label in the menu only; the trigger shows the label alone. */
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
  return (
    <Select items={items} value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        // ! because the trigger's own data-[size=sm]:h-7 outranks a plain max-lg: height
        className="shrink-0 text-xs font-medium max-lg:h-10!"
      >
        <Icon aria-hidden="true" className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      {/* as wide as its widest item, title pills included, inside the viewport */}
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
 * "All products" or one of `products`, key in mono before the name. Lists exactly the
 * products it is given: on a project page, the ones the viewer can see.
 */
export function ProductSelect({
  products,
  value,
  onChange,
}: {
  products: WebProductRefView[];
  /** A product key, or null for all products. */
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  return (
    <FilterSelect
      label="Filter by product"
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
