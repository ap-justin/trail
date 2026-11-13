import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Turns a host name into the addresses it points at. */
export type Resolve = (host: string) => Promise<string[]>;

export const resolveHost: Resolve = async (host) => {
  // lookup has no timeout of its own
  const found = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`resolving ${host} timed out`)),
        5_000,
      ).unref(),
    ),
  ]);
  return found.map((a) => a.address);
};

/** Why a webhook URL is refused; the message says what to send instead. */
export class UnsafeUrlError extends Error {
  override readonly name = "UnsafeUrlError";
}

// [network, prefix length]: loopback, private, link-local (which holds the cloud metadata address
// 169.254.169.254), CGNAT, and the reserved, documentation, benchmarking, multicast and broadcast blocks
const blockedV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const v4Number = (address: string) =>
  address.split(".").reduce((n, part) => n * 256 + Number(part), 0);

const blockedV4Ranges = blockedV4.map(([network, bits]) => {
  const size = 2 ** (32 - bits);
  const start = v4Number(network);
  return [start, start + size - 1] as const;
});

function isBlockedV4(address: string): boolean {
  const n = v4Number(address);
  return blockedV4Ranges.some(([start, end]) => n >= start && n <= end);
}

/** The eight 16-bit groups of an IPv6 address; null if it isn't one. */
function hextets(address: string): number[] | null {
  // the URL parser's canonical form: lowercase, compressed, a dotted tail turned to hex
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head = "", tail, extra] = canonical.split("::");
  if (extra !== undefined) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [
    ...left,
    ...Array(tail === undefined ? 0 : missing).fill("0"),
    ...right,
  ];
  const numbers = all.map((g) => Number.parseInt(g, 16));
  return numbers.some(Number.isNaN) ? null : numbers;
}

const v4Of = (high: number, low: number) =>
  `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

function isBlockedV6(address: string): boolean {
  const g = hextets(address);
  if (g === null) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g6 = 0, h = 0] = g;
  // :: and ::1
  if (g.slice(0, 7).every((x) => x === 0) && (h === 0 || h === 1)) return true;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the IPv4 address inside decides
  if ([a, b, c, d].every((x) => x === 0) && (e === 0xffff || e === 0)) {
    return isBlockedV4(v4Of(g6, h));
  }
  // 64:ff9b::/96 NAT64: the IPv4 address inside decides; 64:ff9b:1::/48 is local-use
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0)
      return isBlockedV4(v4Of(g6, h));
    return true;
  }
  // 2002::/16 6to4: the IPv4 address inside decides
  if (a === 0x2002) return isBlockedV4(v4Of(b, c));
  // 100::/64 discard-only
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true;
  // 2001::/23 protocol assignments (Teredo included), 2001:db8::/32 documentation
  if (a === 0x2001 && (b < 0x200 || b === 0xdb8)) return true;
  // fc00::/7 unique-local (AWS metadata fd00:ec2::254 is here)
  if ((a & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local, fec0::/10 site-local
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast
  if ((a & 0xff00) === 0xff00) return true;
  return false;
}

/** True for loopback, private, link-local, CGNAT, unique-local, metadata, multicast and reserved addresses. */
export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true;
}

export const MAX_URL_LENGTH = 2048;

/** Parses and checks the parts of a webhook URL that need no lookup: https, a host, no credentials. */
export function parseWebhookUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new UnsafeUrlError(
      `the URL is over ${MAX_URL_LENGTH} characters: send a shorter https URL`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(
      "the URL is not valid: send an absolute https URL, like https://bot.example.com/hooks/trail",
    );
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError(
      `the URL uses ${url.protocol.slice(0, -1)}: trail sends webhooks only to https URLs`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError(
      "the URL carries a username or password: leave them out, trail signs every request with the secret instead",
    );
  }
  return url;
}

/** The refusal of a host that points inside; one wording for a literal address and a resolved name. */
const pointsInside = (host: string) =>
  new UnsafeUrlError(
    `${host} points at an internal address (loopback, private, link-local, CGNAT or another reserved range): trail sends webhooks only to public hosts`,
  );

/**
 * The URL's parsed form and the public address to connect to. Throws
 * `UnsafeUrlError` for a URL that is not https or whose host is, or resolves
 * to, any internal address; a name that resolves to both a public and an
 * internal address is refused too.
 */
export async function checkWebhookUrl(
  raw: string,
  resolve: Resolve = resolveHost,
): Promise<{ url: URL; address: string; fallback?: string }> {
  const url = parseWebhookUrl(raw);
  // an IPv6 literal's hostname keeps its brackets
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isInternalAddress(host)) throw pointsInside(host);
    return { url, address: host };
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new UnsafeUrlError(
      `${host} did not resolve (${error instanceof Error ? error.message : "lookup failed"}): send a URL whose host name resolves`,
    );
  }
  const [first] = addresses;
  if (first === undefined) {
    throw new UnsafeUrlError(
      `${host} did not resolve: send a URL whose host name resolves`,
    );
  }
  if (addresses.some(isInternalAddress)) throw pointsInside(host);
  // every address passed the check above, so the one of the other family is as safe to connect to
  const fallback = addresses.find((a) => isIP(a) !== isIP(first));
  return { url, address: first, ...(fallback !== undefined && { fallback }) };
}
