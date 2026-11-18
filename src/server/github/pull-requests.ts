import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  type GithubPullRequestState,
  githubPullRequest,
} from "../db/schema.js";

const MINUTE = 60_000;

/** A pull request's cached state is refreshed once it is older than this. */
const FRESH_MS = 10 * MINUTE;
/** Only pull requests on an item read within this long are refreshed. */
const READ_WINDOW_MS = 24 * 60 * MINUTE;
// GitHub allows 5000 requests an hour with a token (about 83 a minute), and 60 an hour per IP
// without: 20 a minute leaves the token's quota room for its other use, 1 a minute stays under 60
const FETCHES_PER_MINUTE = { token: 20, anonymous: 1 } as const;
/** After n failed fetches in a row, the next waits min(2^n, 60) minutes from the last. */
const BACKOFF_CAP_MINUTES = 60;
const FETCH_TIMEOUT_MS = 10_000;
const POLL_MS = 5_000;

/** What a read shows of a pull request: null before its first successful fetch. */
export type PullRequestState = {
  state: GithubPullRequestState;
  checkedAt: Date;
} | null;

const PULL_URL =
  /^https:\/\/github\.com\/([a-z0-9-]+)\/([a-z0-9._-]+)\/pull\/([1-9]\d*)$/;

/**
 * The canonical (lowercase) url of a GitHub pull request link, or null for any
 * other url. GitHub's own names are case-insensitive, so any case matches.
 */
function pullRequestUrl(url: string): string | null {
  const canonical = url.toLowerCase();
  const match = PULL_URL.exec(canonical);
  // a repo of only dots would make the API path climb out of the owner
  if (!match || /^\.+$/.test(match[2] ?? "")) return null;
  return canonical;
}

/** The fields of GitHub's pull request object the state comes from. */
const pullSchema = z.object({
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
});

function stateOf(pull: z.infer<typeof pullSchema>): GithubPullRequestState {
  if (pull.merged === true || pull.merged_at) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

export type PullRequestOptions = {
  db: Db;
  /** sent as a Bearer token when set; never logged */
  token?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/**
 * GitHub pull request states for item links, cached in github_pull_request.
 * A read never waits on GitHub: it answers from the cache and stamps
 * lastReadAt, and the table is the queue a timer drains, a few fetches a
 * minute, for rows read in the last day whose state is stale and whose
 * backoff has passed.
 */
export function createPullRequests(options: PullRequestOptions) {
  const { db, token } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const perMinute = token
    ? FETCHES_PER_MINUTE.token
    : FETCHES_PER_MINUTE.anonymous;

  /** when each fetch of the last minute started */
  let started: number[] = [];
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const abort = new AbortController();

  /**
   * The cached state of each pull request url among `urls`, keyed by the url
   * as given; other urls are left out. Never throws: when the cache can't be
   * read every pull request reads null.
   */
  function read(urls: string[]): Map<string, PullRequestState> {
    const states = new Map<string, PullRequestState>();
    const canonical = new Map<string, string>();
    for (const url of urls) {
      const pull = pullRequestUrl(url);
      if (pull === null) continue;
      canonical.set(url, pull);
      states.set(url, null);
    }
    if (canonical.size === 0) return states;
    const unique = [...new Set(canonical.values())];
    try {
      const rows = new Map(
        db
          .select()
          .from(githubPullRequest)
          .where(inArray(githubPullRequest.url, unique))
          .all()
          .map((row) => [row.url, row]),
      );
      for (const [url, pull] of canonical) {
        const row = rows.get(pull);
        if (row?.state && row.checkedAt) {
          states.set(url, { state: row.state, checkedAt: row.checkedAt });
        }
      }
      db.insert(githubPullRequest)
        .values(unique.map((url) => ({ url, lastReadAt: new Date(now()) })))
        .onConflictDoUpdate({
          target: githubPullRequest.url,
          set: { lastReadAt: sql`excluded.last_read_at` },
        })
        .run();
    } catch (error) {
      console.error("pull request states not read", error);
    }
    return states;
  }

  /** Up to `limit` urls read in the last day, stale, and past their backoff; the most recently read first. */
  function due(at: number, limit: number): string[] {
    const backoffMinutes = sql`case when ${githubPullRequest.failures} >= 6 then ${BACKOFF_CAP_MINUTES} else 1 << ${githubPullRequest.failures} end`;
    return db
      .select({ url: githubPullRequest.url })
      .from(githubPullRequest)
      .where(
        and(
          gt(githubPullRequest.lastReadAt, new Date(at - READ_WINDOW_MS)),
          or(
            isNull(githubPullRequest.checkedAt),
            lt(githubPullRequest.checkedAt, new Date(at - FRESH_MS)),
          ),
          or(
            sql`${githubPullRequest.failures} = 0`,
            sql`${githubPullRequest.attemptedAt} <= ${at} - ${backoffMinutes} * ${MINUTE}`,
          ),
        ),
      )
      .orderBy(desc(githubPullRequest.lastReadAt))
      .limit(limit)
      .all()
      .map((row) => row.url);
  }

  /** The state GitHub gives, or why there is none; the reason never carries the token. */
  async function fetchState(
    url: string,
  ): Promise<{ state: GithubPullRequestState } | { failed: string }> {
    const [, owner, repo, number] = PULL_URL.exec(url) ?? [];
    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "trail",
            ...(token && { authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.any([
            AbortSignal.timeout(FETCH_TIMEOUT_MS),
            abort.signal,
          ]),
        },
      );
      if (!res.ok) {
        await res.body?.cancel();
        return { failed: `GitHub answered ${res.status}` };
      }
      const pull = pullSchema.safeParse(await res.json());
      if (!pull.success) return { failed: "GitHub's answer has no state" };
      return { state: stateOf(pull.data) };
    } catch (error) {
      return { failed: error instanceof Error ? error.name : "fetch failed" };
    }
  }

  function record(
    url: string,
    result: Awaited<ReturnType<typeof fetchState>>,
    at: number,
  ) {
    const attemptedAt = new Date(at);
    if ("state" in result) {
      db.update(githubPullRequest)
        .set({
          state: result.state,
          checkedAt: attemptedAt,
          attemptedAt,
          failures: 0,
        })
        .where(eq(githubPullRequest.url, url))
        .run();
      return;
    }
    console.warn(`pull request state not refreshed: ${url}: ${result.failed}`);
    db.update(githubPullRequest)
      .set({ attemptedAt, failures: sql`${githubPullRequest.failures} + 1` })
      .where(eq(githubPullRequest.url, url))
      .run();
  }

  async function refresh(url: string) {
    const result = await fetchState(url);
    // a shutdown cut the fetch: nothing was learned about the pull request
    if (abort.signal.aborted) return;
    try {
      record(url, result, now());
    } catch (error) {
      console.error("pull request state not recorded", url, error);
    }
  }

  async function pass() {
    const at = now();
    started = started.filter((t) => at - t < MINUTE);
    const room = perMinute - started.length;
    if (room <= 0 || abort.signal.aborted) return;
    let urls: string[];
    try {
      urls = due(at, room);
    } catch (error) {
      console.error("pull request refresh failed", error);
      return;
    }
    for (const _ of urls) started.push(at);
    await Promise.all(urls.map(refresh));
  }

  /** Fetches what is due within the per-minute limit; resolves when those fetches are recorded. One pass at a time; never rejects. */
  function tick(): Promise<void> {
    if (running) return running;
    const current = pass().finally(() => {
      running = null;
    });
    running = current;
    return current;
  }

  return {
    read,
    tick,
    /** Polls for due pull requests until `stop`. */
    start() {
      if (timer || abort.signal.aborted) return;
      timer = setInterval(() => void tick(), POLL_MS);
      timer.unref();
    },
    /** Stops polling, cuts fetches in flight and waits for the pass to end. */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      abort.abort();
      await running;
    },
  };
}

export type PullRequests = ReturnType<typeof createPullRequests>;
