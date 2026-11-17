import { RowLink } from "@/components/app-link";
import { RepoLink } from "@/components/product";
import {
  ListSkeleton,
  ProductsEmpty,
  ProductsError,
} from "@/components/states";
import {
  Age,
  LatestUpdate,
  NO_HEALTH,
  UpdateHealth,
} from "@/components/status-updates";
import { KeyText } from "@/components/text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WebProductView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

export type ProductsViewProps = {
  status: "loading" | "error" | "ready";
  /** The products the viewer can see, A to Z by key. */
  products: WebProductView[];
  /** Named in the empty state a person with no products sees. */
  ownerName: string;
  isOwner: boolean;
  onRetry: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

function ProductName({
  product,
  size,
}: {
  product: WebProductView;
  size: "table" | "card";
}) {
  return (
    <RowLink
      href={paths.product(product.key)}
      className="flex min-w-0 items-center gap-2"
    >
      <KeyText className={cn("text-foreground", size === "card" && "text-sm")}>
        {product.key}
      </KeyText>{" "}
      <span className="truncate font-semibold">{product.name}</span>
    </RowLink>
  );
}

/** `owner/name` over the row link, so it opens GitHub on its own. */
function RepoLine({ url }: { url: string }) {
  return (
    <RepoLink
      url={url}
      short
      className="relative z-1 w-fit text-muted-foreground"
    />
  );
}

// 16px between columns, 12px at the row's ends
const head = "h-10 px-2 first:pl-3 last:pr-3";
const cell = "px-2 first:pl-3 last:pr-3";
const figure = cn(cell, "text-right");

function ProductsTable({
  products,
  now,
}: {
  products: WebProductView[];
  now: Date;
}) {
  return (
    <Table className="table-fixed max-lg:hidden">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(head, "w-70")}>Product</TableHead>
          <TableHead className={cn(head, "w-29")}>Health</TableHead>
          <TableHead className={head}>Latest status update</TableHead>
          <TableHead className={cn(head, "w-25 text-right")}>
            Open issues
          </TableHead>
          <TableHead className={cn(head, "w-25 text-right")}>
            Open todos
          </TableHead>
          <TableHead className={cn(head, "w-22 text-right")}>
            Projects
          </TableHead>
          <TableHead className={cn(head, "w-19 text-right")}>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => (
          <TableRow
            key={product.key}
            data-product-key={product.key}
            className="relative h-17"
          >
            <TableCell className={cell}>
              <ProductName product={product} size="table" />
              {product.repoUrl && <RepoLine url={product.repoUrl} />}
            </TableCell>
            <TableCell className={cell}>
              <UpdateHealth of={product} empty={NO_HEALTH} />
            </TableCell>
            <TableCell className={cell}>
              <LatestUpdate
                update={product.latestStatusUpdate}
                now={now}
                layout="table"
              />
            </TableCell>
            <TableCell className={figure}>{product.openIssues}</TableCell>
            <TableCell className={figure}>{product.openTodos}</TableCell>
            <TableCell className={figure}>{product.projectCount}</TableCell>
            <TableCell className={cn(cell, "text-right text-muted-foreground")}>
              <Age iso={product.updatedAt} now={now} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ProductCards({
  products,
  now,
}: {
  products: WebProductView[];
  now: Date;
}) {
  return (
    <ul className="lg:hidden">
      {products.map((product) => (
        <li
          key={product.key}
          data-product-key={product.key}
          className="relative flex flex-col gap-2 border-b border-rule px-4 py-3.5"
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <ProductName product={product} size="card" />
              <UpdateHealth of={product} />
            </div>
            {product.repoUrl && <RepoLine url={product.repoUrl} />}
          </div>
          <LatestUpdate
            update={product.latestStatusUpdate}
            now={now}
            layout="card"
          />
          <p className="text-muted-foreground">
            {plural(product.openIssues, "issue", "issues")} ·{" "}
            {plural(product.openTodos, "todo", "todos")} open ·{" "}
            {plural(product.projectCount, "project", "projects")}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every product the viewer can see: a table at 1024px and up, a card each below. Open
 * issues count triage and open; open todos count open.
 */
export function ProductsView(props: ProductsViewProps) {
  const now = useMinuteClock(props.now);
  if (props.status === "loading")
    return <ListSkeleton className="px-4 lg:px-6" />;
  if (props.status === "error")
    return <ProductsError onRetry={props.onRetry} />;
  if (props.products.length === 0) {
    return (
      <ProductsEmpty ownerName={props.ownerName} isOwner={props.isOwner} />
    );
  }
  return (
    <div className="flex flex-col max-lg:pt-3 lg:px-6 lg:py-2">
      <ProductsTable products={props.products} now={now} />
      <ProductCards products={props.products} now={now} />
    </div>
  );
}
