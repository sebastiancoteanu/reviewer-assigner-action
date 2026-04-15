import assert from "node:assert/strict";
import test from "node:test";
import {
	filterAssignableCandidates,
	getCandidateReviewers,
	rankAndChooseReviewers,
} from "../src/reviewer-assignment";
import type { ScoredReviewer } from "../src/types";

test("getCandidateReviewers uses union of codeowners only", async () => {
	const context = {
		logger: { info() {} },
		codeownersResolver: {
			async getCodeOwnersForFile(filePath: string) {
				if (filePath === "src/a.ts") {
					return ["alice", "bob"];
				}
				return ["carol"];
			},
		},
		candidateCoverage: new Map<string, number>(),
		fileDetails: new Map<string, unknown>(),
		historicalFileReviewCounts: new Map<string, number>(),
		octokit: {},
		owner: "acme",
		repo: "repo",
	};

	const candidates = await getCandidateReviewers(
		["src/a.ts", "src/b.ts"],
		context as any,
	);
	assert.deepEqual(new Set(candidates), new Set(["alice", "bob", "carol"]));
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
					async getCollaboratorPermissionLevel({
						username,
					}: {
						username: string;
					}) {
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
	const scored: ScoredReviewer[] = [
		{
			user: "alice",
			score: 1.0,
			metrics: { activeReviews: 0, avgPrSize: 0, fileReviewCount: 1 },
		},
		{
			user: "bob",
			score: 1.0,
			metrics: { activeReviews: 0, avgPrSize: 0, fileReviewCount: 0 },
		},
		{
			user: "carol",
			score: 0.5,
			metrics: { activeReviews: 0, avgPrSize: 0, fileReviewCount: 0 },
		},
	];

	const chosen = rankAndChooseReviewers(scored, 2, () => 0.75).map(
		(item) => item.user,
	);
	assert.equal(chosen[0], "carol");
	assert.equal(chosen[1], "alice");
	assert.equal(chosen.length, 2);
});
