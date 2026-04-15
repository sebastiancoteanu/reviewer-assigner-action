import * as core from "@actions/core";
import * as github from "@actions/github";
import { createCodeownersResolver } from "./codeowners";
import { loadConfig } from "./config";
import {
	assignReviewers,
	createPullRequestContext,
	filterAssignableCandidates,
	getCandidateReviewers,
	getChangedFiles,
	getHistoricalFileReviewCounts,
	getReviewerLoadScore,
	loadOpenPullRequestsForScoring,
	rankAndChooseReviewers,
} from "./reviewer-assignment";
import type { Logger } from "./types";

function createLogger(): Logger {
	return {
		info(message: string): void {
			core.info(message);
		},
		warn(message: string): void {
			core.warning(message);
		},
		error(message: string): void {
			core.error(message);
		},
	};
}

async function maybeLeaveComment(
	pr: { owner: string; repo: string; number: number },
	reviewers: string[],
	context: {
		config: { leave_comment: boolean; dry_run: boolean };
		logger: Logger;
		octokit: any;
	},
): Promise<void> {
	const { config, logger, octokit } = context;
	if (!config.leave_comment || !reviewers.length || config.dry_run) {
		return;
	}

	const body = [
		"Auto-assigned reviewers:",
		"",
		...reviewers.map((reviewer) => `- @${reviewer}`),
		"",
		"Selection logic: CODEOWNERS + historical file reviewers + load balancing.",
	].join("\n");

	await octokit.rest.issues.createComment({
		owner: pr.owner,
		repo: pr.repo,
		issue_number: pr.number,
		body,
	});
	logger.info("Posted assignment comment.");
}

export async function run(): Promise<void> {
	const logger = createLogger();
	const token = core.getInput("github-token", { required: true });
	const configPath =
		core.getInput("config-path") || ".github/reviewer-assignment.yml";
	const octokit = github.getOctokit(token);

	const eventPayload = github.context.payload;
	const pr = createPullRequestContext(eventPayload);

	const config = await loadConfig(
		octokit,
		pr.owner,
		pr.repo,
		logger,
		configPath,
	);
	if (
		config.skip_if_reviewers_already_assigned &&
		pr.requestedReviewers.length > 0
	) {
		logger.info(
			`Skipping: PR already has requested reviewers [${pr.requestedReviewers.join(", ")}]`,
		);
		return;
	}

	const context = {
		octokit,
		owner: pr.owner,
		repo: pr.repo,
		config,
		logger,
		candidateCoverage: new Map<string, number>(),
		fileDetails: new Map<string, unknown>(),
		codeownersResolver: {
			getCodeOwnersForFile: async (_filePath: string) => [] as string[],
		},
		openPullRequests: [] as any[],
		historicalFileReviewCounts: new Map<string, number>(),
	};

	const changedFiles = await getChangedFiles(pr, context);
	if (!changedFiles.length) {
		logger.info("No changed files found after filtering.");
		return;
	}

	context.codeownersResolver = await createCodeownersResolver(
		octokit,
		pr.owner,
		pr.repo,
		logger,
	);
	const candidates = await getCandidateReviewers(changedFiles, context);
	logger.info(`Candidate pool before filtering: [${candidates.join(", ")}]`);

	const assignableCandidates = await filterAssignableCandidates(
		candidates,
		pr.author,
		context,
	);
	logger.info(
		`Candidate pool after filtering: [${assignableCandidates.join(", ")}]`,
	);

	if (!assignableCandidates.length) {
		logger.warn("No assignable candidates found.");
		return;
	}

	context.openPullRequests = await loadOpenPullRequestsForScoring(
		context,
		pr.number,
	);
	context.historicalFileReviewCounts = await getHistoricalFileReviewCounts(
		changedFiles,
		assignableCandidates,
		pr.number,
		context,
	);

	const scored = [];
	for (const candidate of assignableCandidates) {
		scored.push(await getReviewerLoadScore(candidate, context));
	}

	const chosen = rankAndChooseReviewers(scored, config.reviewer_count).map(
		(item) => item.user,
	);
	logger.info(`Final reviewers: [${chosen.join(", ")}]`);

	await assignReviewers(pr, chosen, context);
	await maybeLeaveComment(pr, chosen, context);
}

if (require.main === module) {
	run().catch((error) => {
		core.setFailed(
			`Failed to assign reviewers: ${error?.stack || error?.message || error}`,
		);
	});
}
