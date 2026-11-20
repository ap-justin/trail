import type { ProductKind } from "../../server/db/schema";

/** A product view that may say whether it is a team; one seen only through a project doesn't. */
export type WithKind = { kind?: ProductKind };

export const isTeam = (product: WithKind) => product.kind === "team";

/** Products and teams apart, each in the order given; a product with no kind is a product. */
export function splitByKind<T extends WithKind>(
  list: T[],
): { products: T[]; teams: T[] } {
  return {
    products: list.filter((p) => !isTeam(p)),
    teams: list.filter(isTeam),
  };
}
