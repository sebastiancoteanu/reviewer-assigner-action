import assert from "node:assert/strict";
import test from "node:test";
import { getReviewerLoadScore } from "../src/reviewer-assignment";

test("getReviewerLoadScore computes weighted score from load metrics", async () => {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  const context = {
    logger: { info() {} },
    openPullRequests: [
      {
        additions: 10,
        deletions: 20,
        requested_reviewers: [{ login: "alice" }],
        reviews: [{ user: { login: "alice" }, submitted_at: twoHoursAgo }],
      },
      {
        additions: 30,
        deletions: 10,
        requested_reviewers: [{ login: "alice" }],
        reviews: [{ user: { login: "alice" }, submitted_at: twoDaysAgo }],
      },
      {
        additions: 200,
        deletions: 100,
        requested_reviewers: [{ login: "bob" }],
        reviews: [],
      },
    ],
  };

  const result = await getReviewerLoadScore("alice", context as any);

  assert.equal(result.metrics.active_reviews, 2);
  assert.equal(result.metrics.recent_reviews_24h, 1);
  assert.equal(result.metrics.avg_pr_size, 35);
  assert.equal(result.score, 2 * 1.0 + 1 * 0.5 + 35 * 0.3);
});
