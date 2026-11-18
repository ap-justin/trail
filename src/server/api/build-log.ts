/**
 * Whether a comment body reads like a build log, by counting the tokens build
 * logs are made of. Leftmost match wins and consumes its text, so a run URL's
 * digits aren't counted again as a bare run id; the alternatives are:
 * - a GitHub Actions run URL: github.com/<owner>/<repo>/actions/runs/<digits>
 * - a bare run id: a whole word of 9 or more digits
 * - an agent, run or request id: agt_, run_ or req_ and 8+ letters and digits
 *   with at least one digit, so a word like run_tests isn't one
 * - a commit SHA: a whole word of 7 to 40 lowercase hex characters with both a
 *   letter and a digit, so neither a plain number nor a word like "defaced" is one
 */
const TOKEN =
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+\S*|\b\d{9,}\b|\b((?:agt|run|req)_(?=[A-Za-z]*\d)[A-Za-z0-9]{8,})\b|\b([0-9a-f]{7,40})\b/g;

/** One token anywhere in a body this long is enough. */
const LONG_BODY = 600;

type Kind = "sha" | "ci" | "agent";

const NAMES: Record<Kind, [one: string, many: string]> = {
  sha: ["commit SHA", "commit SHAs"],
  ci: ["CI run", "CI runs"],
  agent: ["agent run id", "agent run ids"],
};

function kindOf(match: RegExpExecArray): Kind | null {
  const [, agentId, hex] = match;
  if (agentId !== undefined) return "agent";
  if (hex !== undefined) {
    return /[a-f]/.test(hex) && /\d/.test(hex) ? "sha" : null;
  }
  return "ci";
}

/**
 * The hint an add_comment answer carries when its body reads like a build
 * log: 2 or more tokens, or 1 in a body over 600 characters. Undefined
 * otherwise; the comment is saved as sent either way.
 */
export function buildLogHint(body: string): string | undefined {
  const counts: Record<Kind, number> = { sha: 0, ci: 0, agent: 0 };
  for (const match of body.matchAll(TOKEN)) {
    const kind = kindOf(match);
    if (kind !== null) counts[kind]++;
  }
  const total = counts.sha + counts.ci + counts.agent;
  if (total === 0 || (total < 2 && body.length <= LONG_BODY)) return undefined;
  const found = (Object.keys(NAMES) as Kind[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => {
      const [one, many] = NAMES[kind];
      return `${counts[kind]} ${counts[kind] === 1 ? one : many}`;
    })
    .join(", ");
  return `This comment looks like a build log: ${found}. It is saved, but that detail belongs on the pull request: link the PR with update_item addLinks, where trail shows its state, and keep the comment to status, a decision or a blocker.`;
}
