import { expect, test } from "vitest";
import { buildLogHint } from "./build-log.js";

/** `lead` followed by filler with no token in it, exactly `length` characters long. */
function bodyOf(length: number, lead: string) {
  const filler = " nothing else is open on this work".repeat(30);
  return (lead + filler).slice(0, length);
}

const sha = "3f9c2a1";

test("one token gets no hint however long the body; two do", () => {
  expect(buildLogHint(`Pushed ${sha}`, "rest")).toBeUndefined();
  expect(buildLogHint(bodyOf(2000, `Landed in ${sha}`), "rest")).toBeUndefined();
  expect(
    buildLogHint(bodyOf(2000, `Landed in ${sha} and b71e04d9`), "rest"),
  ).toMatch(/build log: 2 commit SHAs\./);
});

// a second, always-counted token, so a test can ask whether the first one counted
const other = "b71e04d9";

test("a commit SHA is 7 to 40 hex characters: 40 counts, 41 does not", () => {
  const forty = "a1".repeat(20);
  const fortyOne = `${forty}b`;
  expect(buildLogHint(`Head ${forty} and ${other}`, "rest")).toMatch(
    /2 commit SHAs\./,
  );
  // a word that doesn't count leaves `other` alone, which is one token
  expect(buildLogHint(`Head ${fortyOne} and ${other}`, "rest")).toBeUndefined();
  expect(buildLogHint(`Head a1b2c3 and ${other}`, "rest")).toBeUndefined();
});

test("a hex word with no digit or no letter is not a commit SHA", () => {
  const lettersOnly = "Only defaced and facade, deadbeef and abcdefab changed.";
  expect(buildLogHint(`${lettersOnly} ${other}`, "rest")).toBeUndefined();
  expect(
    buildLogHint(`Only 12345678 and 7654321 rows, ${other}`, "rest"),
  ).toBeUndefined();
  // a real SHA in the same place counts
  expect(buildLogHint(`Only ${sha} changed, ${other}`, "rest")).toMatch(
    /2 commit SHAs\./,
  );
});

test("an uppercase hex word is not a commit SHA", () => {
  expect(buildLogHint(`Head 3F9C2A1 and ${other}`, "rest")).toBeUndefined();
});

test("agent run ids count, one alone does not", () => {
  const id = "agt_7Hk2pQ9xR4";
  expect(buildLogHint(`Done in ${id} and ${other}`, "rest")).toMatch(
    /1 commit SHA, 1 agent run id\./,
  );
  expect(buildLogHint(bodyOf(2000, `Done in ${id}`), "rest")).toBeUndefined();
});

test("a run URL counts once, even with a run id too short to count on its own", () => {
  const url = "https://github.com/example-org/widget/actions/runs/1234567890";
  const short = "https://github.com/example-org/widget/actions/runs/4521";
  expect(buildLogHint(`${url} then ${other}`, "rest")).toMatch(
    /1 commit SHA, 1 CI run\./,
  );
  expect(buildLogHint(`${short} then ${other}`, "rest")).toMatch(
    /1 commit SHA, 1 CI run\./,
  );
  expect(buildLogHint(`${short} and ${url}`, "rest")).toMatch(/: 2 CI runs\./);
});

test("the hint names the way to link the pull request on each surface", () => {
  const body = `Pushed ${sha} and 0a1b2c3d4e.`;
  expect(buildLogHint(body, "rest")).toMatch(
    /PATCH \/items\/\{key\} with addLinks/,
  );
  expect(buildLogHint(body, "mcp")).toMatch(/update_item addLinks/);
});
