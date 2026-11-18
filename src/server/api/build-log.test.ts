import { expect, test } from "vitest";
import { buildLogHint } from "./build-log.js";

/** `lead` followed by filler with no token in it, exactly `length` characters long. */
function bodyOf(length: number, lead: string) {
  const filler = " nothing else is open on this work".repeat(30);
  return (lead + filler).slice(0, length);
}

const sha = "3f9c2a1";

test("one token in a body of exactly 600 characters gets no hint; at 601 it does", () => {
  const at600 = bodyOf(600, `Pushed ${sha}`);
  const at601 = bodyOf(601, `Pushed ${sha}`);
  expect([at600.length, at601.length]).toEqual([600, 601]);
  expect(buildLogHint(at600, "rest")).toBeUndefined();
  expect(buildLogHint(at601, "rest")).toMatch(/build log: 1 commit SHA\./);
});

test("a commit SHA is 7 to 40 hex characters: 40 counts, 41 does not", () => {
  const forty = "a1".repeat(20);
  const fortyOne = `${forty}b`;
  expect(buildLogHint(bodyOf(601, `Head ${forty}`), "rest")).toMatch(
    /1 commit SHA\./,
  );
  expect(buildLogHint(bodyOf(601, `Head ${fortyOne}`), "rest")).toBeUndefined();
  expect(buildLogHint(bodyOf(601, "Head a1b2c3"), "rest")).toBeUndefined();
});

test("a hex word with no digit or no letter is not a commit SHA", () => {
  const lettersOnly = "Only defaced and facade, deadbeef and abcdefab changed.";
  expect(buildLogHint(bodyOf(601, lettersOnly), "rest")).toBeUndefined();
  expect(
    buildLogHint(bodyOf(601, "Only 12345678 and 7654321 rows"), "rest"),
  ).toBeUndefined();
  // a real SHA in the same place counts
  expect(buildLogHint(bodyOf(601, `Only ${sha} changed`), "rest")).toMatch(
    /1 commit SHA\./,
  );
});

test("an uppercase hex word is not a commit SHA", () => {
  expect(buildLogHint(bodyOf(601, "Head 3F9C2A1"), "rest")).toBeUndefined();
});

test("a single agent run id in a long body gets a hint; in a short one it does not", () => {
  const id = "agt_7Hk2pQ9xR4";
  expect(buildLogHint(bodyOf(601, `Done in ${id}`), "rest")).toMatch(
    /1 agent run id\./,
  );
  expect(buildLogHint(`Done in ${id}`, "rest")).toBeUndefined();
});

test("a run URL counts once, even with a run id too short to count on its own", () => {
  const url = "https://github.com/example-org/widget/actions/runs/1234567890";
  const short = "https://github.com/example-org/widget/actions/runs/4521";
  expect(buildLogHint(bodyOf(601, url), "rest")).toMatch(/: 1 CI run\./);
  expect(buildLogHint(bodyOf(601, short), "rest")).toMatch(/: 1 CI run\./);
  expect(buildLogHint(`${short} and ${url}`, "rest")).toMatch(/: 2 CI runs\./);
});

test("the hint names the way to link the pull request on each surface", () => {
  const body = `Pushed ${sha} and 0a1b2c3d4e.`;
  expect(buildLogHint(body, "rest")).toMatch(
    /PATCH \/items\/\{key\} with addLinks/,
  );
  expect(buildLogHint(body, "mcp")).toMatch(/update_item addLinks/);
});
