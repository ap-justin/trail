import type { Database } from "better-sqlite3";

/**
 * Each product's own bot, as migration 0015 resolves it. An entry matches the bot whose label
 * is `agentLabel` when it has one, else (or when no bot carries that label) the bot named `bot`,
 * ignoring ASCII case.
 */
export type ProductOwnerSeed = {
  key: string;
  bot: string;
  agentLabel?: string;
};

export const productOwnerSeeds: readonly ProductOwnerSeed[] = [
  {
    key: "TRL",
    bot: "Tara",
    agentLabel: "agent-3ff34428-5bed-477d-88ab-4bbcd78901e1",
  },
  { key: "KRU", bot: "Kai" },
  { key: "SKY", bot: "Skye" },
  { key: "DOOP", bot: "Nia" },
  { key: "LIA", bot: "Quinn" },
  { key: "ECARDS", bot: "Holly" },
  { key: "BRAND", bot: "Wren" },
  { key: "STAND", bot: "Nora" },
  { key: "NPAPI", bot: "Rhea" },
  { key: "OFR", bot: "Faye" },
  { key: "ERRORS", bot: "Remy" },
  { key: "BGCONN", bot: "Juno" },
  { key: "BGP", bot: "Ivy" },
  { key: "DS", bot: "Pia" },
  { key: "CAD", bot: "Lena" },
  { key: "BOT", bot: "Vera" },
];

export type OwnerResolution = {
  product: string;
  /** the seed's bot name; null when the product has no seed entry */
  bot: string | null;
  resolvedBy: "label" | "name" | "none";
  ownerId: string | null;
};

/**
 * How every product in the database resolves its owner against `seeds`, in key order. Reads
 * only; migration 0015 writes what this returns.
 */
export function resolveProductOwners(
  sqlite: Database,
  seeds: readonly ProductOwnerSeed[] = productOwnerSeeds,
): OwnerResolution[] {
  const byLabel = sqlite
    .prepare<[string], string>(
      "select id from actor where kind = 'bot' and label = ?",
    )
    .pluck();
  // the bot-name index is unique on lower(display_name), so at most one row
  const byName = sqlite
    .prepare<[string], string>(
      "select id from actor where kind = 'bot' and lower(display_name) = lower(?)",
    )
    .pluck();
  const keys = sqlite
    .prepare<[], string>("select key from product order by key")
    .pluck()
    .all();
  return keys.map((product) => {
    const seed = seeds.find((s) => s.key === product);
    if (!seed) return { product, bot: null, resolvedBy: "none", ownerId: null };
    const labelled =
      seed.agentLabel === undefined ? undefined : byLabel.get(seed.agentLabel);
    if (labelled !== undefined) {
      return { product, bot: seed.bot, resolvedBy: "label", ownerId: labelled };
    }
    const named = byName.get(seed.bot);
    if (named !== undefined) {
      return { product, bot: seed.bot, resolvedBy: "name", ownerId: named };
    }
    return { product, bot: seed.bot, resolvedBy: "none", ownerId: null };
  });
}
