import assert from "node:assert/strict";
import test from "node:test";
import { getOwnersForFile, parseCodeowners } from "../src/codeowners";

test("parseCodeowners parses rules and owners", () => {
  const content = `
# comment line
/src/** @org/platform @alice
docs/ @org/docs
README.md @bob
`;

  const rules = parseCodeowners(content);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules[0], { pattern: "/src/**", owners: ["@org/platform", "@alice"] });
});

test("getOwnersForFile returns last matching rule", () => {
  const rules = parseCodeowners(`
/src/** @team/eng
/src/api/** @team/backend @alice
`);

  const owners = getOwnersForFile("src/api/client.ts", rules);
  assert.deepEqual(owners, ["@team/backend", "@alice"]);
});

test("getOwnersForFile matches directory rule", () => {
  const rules = parseCodeowners(`
docs/ @team/docs
`);

  const owners = getOwnersForFile("docs/setup/install.md", rules);
  assert.deepEqual(owners, ["@team/docs"]);
});
