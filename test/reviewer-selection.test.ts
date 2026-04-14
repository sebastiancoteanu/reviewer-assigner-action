import assert from "node:assert/strict";
import test from "node:test";
import {
  filterAssignableCandidates,
  getCandidateReviewers,
  rankAndChooseReviewers,
} from "../src/reviewer-assignment";

test("getCandidateReviewers uses strict intersection when available", async () => {
  const context = {
    config: { lookback_days: 60, recent_editors_limit: 3 },
    logger: { info() {} },
    codeownersResolver: {
      async getCodeOwnersForFile(filePath: string) {
        if (filePath === "src/a.ts") {
          return ["alice", "bob"];
        }
        return ["carol"];
      },
    },
    recentEditorsCache: new Map<string, Promise<string[]>>(),
    candidateCoverage: new Map<string, number>(),
    fileDetails: new Map<string, unknown>(),
    commitStatsCache: new Map<string, Promise<any>>(),
    octokit: {},
    owner: "acme",
    repo: "repo",
  };

  context.recentEditorsCache.set("src/a.ts", Promise.resolve(["alice", "dave"]));
  context.recentEditorsCache.set("src/b.ts", Promise.resolve(["eve"]));

  const candidates = await getCandidateReviewers(["src/a.ts", "src/b.ts"], context as any);
  assert.deepEqual(new Set(candidates), new Set(["alice", "carol"]));
});

test("filterAssignableCandidates removes author, bots, duplicates and excluded users", async () => {
  const context = {
    owner: "acme",
    repo: "repo",
    config: { exclude_users: ["carol"], exclude_bots: true },
    logger: { info() {} },
    octokit: {
      rest: {
        repos: {
          async getCollaboratorPermissionLevel({ username }: { username: string }) {
            if (username === "frank") {
              throw Object.assign(new Error("not assignable"), { status: 404 });
            }
            return { data: { permission: "write" } };
          },
        },
      },
    },
  };

  const filtered = await filterAssignableCandidates(
    ["alice", "alice", "carol", "renovate[bot]", "frank", "bob"],
    "bob",
    context as any,
  );
  assert.deepEqual(filtered, ["alice"]);
});

test("rankAndChooseReviewers sorts by score and randomizes ties", () => {
  const scored = [
    { user: "alice", score: 1.0, metrics: { active_reviews: 0, recent_reviews_24h: 0, avg_pr_size: 0 } },
    { user: "bob", score: 1.0, metrics: { active_reviews: 0, recent_reviews_24h: 0, avg_pr_size: 0 } },
    { user: "carol", score: 0.5, metrics: { active_reviews: 0, recent_reviews_24h: 0, avg_pr_size: 0 } },
  ];

  const chosen = rankAndChooseReviewers(scored, 2, () => 0.75).map((item) => item.user);
  assert.equal(chosen[0], "carol");
  assert.equal(chosen.length, 2);
});
