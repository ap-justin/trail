import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actor, product } from "../db/schema.js";
import { NotFoundError } from "./errors.js";
import { botByRef } from "./keys.js";
import type { Tx } from "./tx.js";
import { validRepoUrl } from "./validate.js";

/** What an operator change to a product did: the field's value before and after, null for none. */
export type ProductChange = { key: string; from: string | null; to: string };

type ProductRow = typeof product.$inferSelect;

function productByKey(tx: Tx, key: string): ProductRow {
  const found = tx
    .select()
    .from(product)
    .where(eq(product.key, key.trim().toUpperCase()))
    .get();
  if (!found) {
    throw new NotFoundError(
      `no product ${key}: \`trail products owners\` lists every product's key`,
    );
  }
  return found;
}

const botLabel = (row: { id: string; displayName: string }) =>
  `${row.displayName} (${row.id})`;

/**
 * Makes the bot `botRef` names (id, label or name, as `renameBot` finds it)
 * the product's owner, whose items are todos. An operator write: no activity
 * event, as a bot rename has none.
 */
export function setProductOwner(
  db: Db,
  key: string,
  botRef: string,
): ProductChange {
  return db.transaction(
    (tx) => {
      const target = productByKey(tx, key);
      const bot = botByRef(tx, botRef, "a product's owner is a bot");
      const before =
        target.ownerId === null
          ? undefined
          : tx.select().from(actor).where(eq(actor.id, target.ownerId)).get();
      tx.update(product)
        .set({ ownerId: bot.id, updatedAt: new Date() })
        .where(eq(product.id, target.id))
        .run();
      return {
        key: target.key,
        from: before ? botLabel(before) : null,
        to: botLabel(bot),
      };
    },
    { behavior: "immediate" },
  );
}

/** Sets the product's GitHub repository URL, as `update_product`'s repoUrl takes it. */
export function setProductRepo(
  db: Db,
  key: string,
  url: string,
): ProductChange {
  const repoUrl = validRepoUrl(url) as string;
  return db.transaction(
    (tx) => {
      const target = productByKey(tx, key);
      tx.update(product)
        .set({ repoUrl, updatedAt: new Date() })
        .where(eq(product.id, target.id))
        .run();
      return { key: target.key, from: target.repoUrl, to: repoUrl };
    },
    { behavior: "immediate" },
  );
}
