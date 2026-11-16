import { z } from "@hono/zod-openapi";

type Field = z.ZodType;

/** A field documented as another's alias, like "Deprecated alias of item.": the field it stands for. */
const ALIAS_DESCRIPTION = /^(?:Deprecated )?[Aa]lias of (\w+)/;

/** The schema a wrapper (optional, nullable, default) holds. */
const innerOf = (field: Field) =>
  (field.def as { innerType?: Field }).innerType;

function unwrapped(field: Field): Field {
  const inner = innerOf(field);
  return inner === undefined ? field : unwrapped(inner);
}

/** The outermost description, which `.optional()` after `.meta()` leaves on the inner schema. */
function descriptionOf(field: Field): string {
  for (let at: Field | undefined = field; at; at = innerOf(at)) {
    if (at.description !== undefined) return at.description;
  }
  return "";
}

const aliasTarget = (field: Field) =>
  ALIAS_DESCRIPTION.exec(descriptionOf(field))?.[1];

/** Optional in the schema only because an alias or another field may stand in: its description starts "Required unless …" or "Required, unless …". */
const isRequired = (field: Field) =>
  !field.isOptional() || descriptionOf(field).startsWith("Required");

function placeholder(field: Field): unknown {
  for (let at: Field | undefined = field; at; at = innerOf(at)) {
    const example = z.globalRegistry.get(at)?.example;
    if (example !== undefined) return example;
  }
  const inner = unwrapped(field);
  const def = inner.def as {
    type: string;
    entries?: Record<string, unknown>;
    values?: unknown[];
    element?: Field;
    options?: Field[];
  };
  switch (def.type) {
    case "enum":
      return Object.values(def.entries ?? {})[0];
    case "literal":
      return def.values?.[0];
    case "number":
    case "int":
      return 1;
    case "boolean":
      return true;
    case "array":
      return def.element ? [placeholder(def.element)] : [];
    case "union":
      return def.options?.[0] ? placeholder(def.options[0]) : "...";
    case "object":
      return minimalArguments(inner as z.ZodObject);
    case "string":
      return stringPlaceholder(inner as z.ZodString);
    default:
      return "...";
  }
}

function stringPlaceholder(field: z.ZodString): string {
  if (field.format === "url") return "https://example.com/trail";
  const min = field.minLength ?? 0;
  return min > 3 ? `<at least ${min} characters>`.padEnd(min, ".") : "...";
}

function minimalArguments(schema: z.ZodObject): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.shape as Record<string, Field>)
      .filter(([, field]) => isRequired(field))
      .map(([name, field]) => [name, placeholder(field)]),
  );
}

const squashed = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** The name fewest edits from `sent`, within two edits and short of rewriting the whole name. */
function nearest(sent: string, names: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const known = squashed(name);
    const distance = editDistance(known, sent);
    if (distance > Math.min(2, known.length - 1)) continue;
    if (best === undefined || distance < best.distance) {
      best = { name, distance };
    }
  }
  return best?.name;
}

/** The field an unknown key most likely meant, steered from an alias to the field it stands for. */
function meant(key: string, shape: Record<string, Field>): string | undefined {
  const sent = squashed(key);
  const names = Object.keys(shape);
  const match =
    names.find((name) => squashed(name) === sent) ??
    names.find((name) => {
      const known = squashed(name);
      // a two-letter prefix, sent or known, is too weak to guess from: topic is not to
      return (
        Math.min(sent.length, known.length) > 2 &&
        (sent.startsWith(known) || known.startsWith(sent))
      );
    }) ??
    nearest(sent, names);
  if (match === undefined) return undefined;
  const field = shape[match];
  return (field && aliasTarget(field)) ?? match;
}

type ErrorMap = (issue: {
  code?: string;
  keys?: string[];
}) => string | { message?: string } | undefined | null;

const messageOf = (result: ReturnType<ErrorMap>) =>
  typeof result === "string" ? result : (result?.message ?? undefined);

/**
 * `schema` refusing an unknown argument with what to send instead: the field
 * it likely meant, the fields `tool` takes (aliases left out) and a minimal
 * call built from the required fields. An advice the schema already gives for
 * a renamed field is kept, in place of the guess.
 */
export function withArgumentHelp<T>(tool: string, schema: T): T {
  if (!(schema instanceof z.ZodObject)) return schema;
  const shape = schema.shape as Record<string, Field>;
  const own = schema.def.error as ErrorMap | undefined;
  const fields = Object.keys(shape).filter((name) => {
    const field = shape[name];
    return field !== undefined && aliasTarget(field) === undefined;
  });
  const takes =
    fields.length === 0
      ? `${tool} takes no arguments`
      : `${tool} takes ${fields.join(", ")}`;
  const example = `A minimal call: ${tool} ${JSON.stringify(minimalArguments(schema))}`;
  const error: ErrorMap = (issue) => {
    if (issue.code !== "unrecognized_keys" || issue.keys === undefined) {
      return own?.(issue);
    }
    const unknown =
      messageOf(own?.(issue)) ??
      `Unrecognized key${issue.keys.length > 1 ? "s" : ""} ${issue.keys
        .map((key) => {
          const guess = meant(key, shape);
          return guess === undefined
            ? `"${key}"`
            : `"${key}" (did you mean ${guess}?)`;
        })
        .join(", ")}`;
    return `${unknown}. ${takes}. ${example}`;
  };
  return schema.clone({ ...schema.def, error } as typeof schema.def) as T;
}
