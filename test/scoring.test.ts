import assert from "node:assert/strict";
import test from "node:test";
import { getReviewerLoadScore } from "../src/reviewer-assignment";

test("getReviewerLoadScore computes weighted score from load metrics", async () => {
	const context = {
		logger: { info() {} },
		historicalFileReviewCounts: new Map([["alice", 4]]),
		openPullRequests: [
			{
				additions: 10,
				deletions: 20,
				requested_reviewers: [{ login: "alice" }],
				reviews: [{ user: { login: "alice" } }],
			},
			{
				additions: 30,
				deletions: 10,
				requested_reviewers: [{ login: "alice" }],
				reviews: [{ user: { login: "alice" } }],
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

	assert.equal(result.metrics.activeReviews, 2);
	assert.equal(result.metrics.avgPrSize, 35);
	assert.equal(result.metrics.fileReviewCount, 4);
	assert.equal(result.score, 2 * 1.0 + 35 * 0.3);
});
