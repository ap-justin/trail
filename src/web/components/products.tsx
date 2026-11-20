import { useId } from "react";
import { ActorAvatar, actorNameGroup, BotTitle } from "@/components/actor";
import { RowLink } from "@/components/app-link";
import { MarkdownText } from "@/components/markdown-text";
import { RepoLink } from "@/components/product";
import {
  ListSkeleton,
  ProductsEmpty,
  ProductsError,
} from "@/components/states";
import {
  Age,
  AsideHeading,
  LatestUpdate,
  NO_HEALTH,
  NO_STATUS_UPDATE,
  UpdateHealth,
} from "@/components/status-updates";
import { KeyPill, TeamBadge } from "@/components/text";
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
import { isTeam, splitByKind, type WithKind } from "@/lib/product-kind";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

type ListedProduct = WebProductView & WithKind;

export type ProductsViewProps = {
  status: "loading" | "error" | "ready";
  /** The products and teams the viewer can see, A to Z by key; teams list apart under Teams. */
  products: ListedProduct[];
  /** Named in the empty state a person with no products sees. */
  ownerName: string;
  isOwner: boolean;
  onRetry: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

function ProductName({ product }: { product: ListedProduct }) {
  return (
    <RowLink
      href={paths.product(product.key)}
      className="flex min-w-0 items-center gap-2"
    >
      <span className="truncate font-medium">{product.name}</span>{" "}
      <KeyPill>{product.key}</KeyPill>
      {isTeam(product) && (
        <>
          {" "}
          <TeamBadge />
        </>
      )}
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
  noun,
  now,
}: {
  products: ListedProduct[];
  /** The first column's header. */
  noun: "Product" | "Team";
  now: Date;
}) {
  return (
    <Table className="table-fixed max-lg:hidden">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(head, "w-70")}>{noun}</TableHead>
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
              <ProductName product={product} />
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

/** A count in ink, its noun in grey: `6 issues`, with "open" for screen readers when it applies. */
function Count({
  count,
  one,
  many,
  open = false,
}: {
  count: number;
  one: string;
  many: string;
  open?: boolean;
}) {
  return (
    <span>
      <span className="font-medium text-foreground">{count}</span>{" "}
      {open && <span className="sr-only">open </span>}
      {count === 1 ? one : many}
    </span>
  );
}

/**
 * Below lg, a card each: key, name and health; the latest update's author over two lines
 * of it (or "No status update yet"); then the open counts and the product's age.
 */
function ProductCards({
  products,
  now,
}: {
  products: ListedProduct[];
  now: Date;
}) {
  return (
    <ul className="lg:hidden">
      {products.map((product) => {
        const update = product.latestStatusUpdate;
        return (
          <li
            key={product.key}
            data-product-key={product.key}
            className="relative mx-4 flex flex-col gap-2 border-b border-rule py-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              <ProductName product={product} />
              <UpdateHealth of={product} />
            </div>
            {update ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ActorAvatar actor={update.author} size="xs" />
                  <span className={actorNameGroup}>
                    <span className="min-w-0 truncate font-medium">
                      {update.author.name}
                    </span>{" "}
                    <BotTitle actor={update.author} />
                  </span>
                </div>
                <p className="line-clamp-2 text-muted-foreground">
                  <MarkdownText source={update.body} />
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">{NO_STATUS_UPDATE}</p>
            )}
            <p className="flex gap-3.5 text-xs text-muted-foreground">
              <Count
                count={product.openIssues}
                one="issue"
                many="issues"
                open
              />{" "}
              <Count count={product.openTodos} one="todo" many="todos" open />{" "}
              <Count
                count={product.projectCount}
                one="project"
                many="projects"
              />{" "}
              <span className="ml-auto">
                <Age iso={product.updatedAt} now={now} />
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Every product the viewer can see: a table at 1024px and up, a card each below. Teams follow
 * in their own table and cards under a Teams heading, drawn only when there is one. Open
 * issues count triage and open; open todos count open.
 */
export function ProductsView(props: ProductsViewProps) {
  const now = useMinuteClock(props.now);
  const teamsHeading = useId();
  if (props.status === "loading")
    return <ListSkeleton className="px-4 lg:px-6" />;
  if (props.status === "error")
    return <ProductsError onRetry={props.onRetry} />;
  if (props.products.length === 0) {
    return (
      <ProductsEmpty ownerName={props.ownerName} isOwner={props.isOwner} />
    );
  }
  const { products, teams } = splitByKind(props.products);
  return (
    <div className="flex flex-col max-lg:pt-3 lg:px-6 lg:py-2">
      {products.length > 0 && (
        <>
          <ProductsTable products={products} noun="Product" now={now} />
          <ProductCards products={products} now={now} />
        </>
      )}
      {teams.length > 0 && (
        <section
          aria-labelledby={teamsHeading}
          className={cn(products.length > 0 && "mt-6")}
        >
          <AsideHeading id={teamsHeading} className="max-lg:px-4 lg:px-3">
            Teams
          </AsideHeading>
          <ProductsTable products={teams} noun="Team" now={now} />
          <ProductCards products={teams} now={now} />
        </section>
      )}
    </div>
  );
}
