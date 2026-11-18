/**
 * Whether a comment body reads like a build log, by counting the tokens build
 * logs are made of. Leftmost match wins and consumes its text, so a run URL's
 * digits aren't counted again as a bare run id; the alternatives are:
 * - a UUID, counted as nothing: trail's own ids are UUIDs, and their 8- and
 *   12-hex groups would otherwise read as commit SHAs
 * - a GitHub Actions run URL: github.com/<owner>/<repo>/actions/runs/<digits>
 * - a bare run id: a whole word of 9 or more digits
 * - an agent, run or request id: agt_, run_ or req_ and 8+ letters and digits
 *   with at least one digit, so a word like run_tests isn't one
 * - a commit SHA: a whole word of 7 to 40 lowercase hex characters with both a
 *   letter and a digit, so neither a plain number nor a word like "defaced" is one
 */
const TOKEN =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b|https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)\S*|\b\d{9,}\b|\b((?:agt|run|req)_(?=[A-Za-z]*\d)[A-Za-z0-9]{8,})\b|\b([0-9a-f]{7,40})\b/g;

type Kind = "sha" | "ci" | "agent";

/** Who reads the hint: a REST caller or an MCP client, each told its own way to link a PR. */
export type Surface = "rest" | "mcp";

const LINK_PR: Record<Surface, string> = {
  rest: "PATCH /items/{key} with addLinks",
  mcp: "update_item addLinks",
};

const NAMES: Record<Kind, [one: string, many: string]> = {
  sha: ["commit SHA", "commit SHAs"],
  ci: ["CI run", "CI runs"],
  agent: ["agent run id", "agent run ids"],
};

/** The token a match is, keyed by what it names: a commit's hex, a run id, an agent id. */
function tokenOf(match: RegExpExecArray): { kind: Kind; id: string } | null {
  const [whole, uuid, urlRunId, agentId, hex] = match;
  if (uuid !== undefined) return null;
  if (urlRunId !== undefined) return { kind: "ci", id: urlRunId };
  if (agentId !== undefined) return { kind: "agent", id: agentId };
  if (hex !== undefined) {
    return /[a-f]/.test(hex) && /\d/.test(hex)
      ? { kind: "sha", id: hex }
      : null;
  }
  return { kind: "ci", id: whole };
}

/** A SHA that is a prefix of another in the set is the same commit, abbreviated. */
function distinctCommits(shas: Set<string>): number {
  const all = [...shas];
  return all.filter(
    (sha) => !all.some((longer) => longer !== sha && longer.startsWith(sha)),
  ).length;
}

/**
 * The hint a created comment carries when its body reads like a build log: 2
 * or more tokens, however long the body. A token counts once per distinct
 * commit, run or id, so naming one commit twice, or as a short SHA linked to
 * its full one, is still one token. One token is a normal comment, even a long
 * closing note naming the commit it landed in. Undefined otherwise; the
 * comment is saved as sent either way.
 */
export function buildLogHint(
  body: string,
  surface: Surface,
): string | undefined {
  const ids: Record<Kind, Set<string>> = {
    sha: new Set(),
    ci: new Set(),
    agent: new Set(),
  };
  for (const match of body.matchAll(TOKEN)) {
    const token = tokenOf(match);
    if (token !== null) ids[token.kind].add(token.id);
  }
  const counts: Record<Kind, number> = {
    sha: distinctCommits(ids.sha),
    ci: ids.ci.size,
    agent: ids.agent.size,
  };
  const total = counts.sha + counts.ci + counts.agent;
  if (total < 2) return undefined;
  const found = (Object.keys(NAMES) as Kind[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => {
      const [one, many] = NAMES[kind];
      return `${counts[kind]} ${counts[kind] === 1 ? one : many}`;
    })
    .join(", ");
  return `This comment looks like a build log: ${found}. It is saved. That detail belongs on the pull request: link the PR with ${LINK_PR[surface]}, where trail shows its state, and keep the comment to status, a decision or a blocker.`;
}
