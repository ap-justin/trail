/**
 * A path on this site, or nothing. A browser reads `//`, a backslash, or a `/` after
 * stripped whitespace as the start of another host.
 */
export function samePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return;
  if (value.startsWith("//") || /[\\\s]/.test(value)) return;
  return value;
}
