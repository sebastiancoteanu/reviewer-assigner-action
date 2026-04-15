import { isBotLogin, shuffle, uniq, withRetry } from "./utils";
import type {
	ActionContext,
	PullRequestContext,
	ScoredReviewer,
} from "./types";

const GENERATED_FILE_PATTERN =
	/\.(min\.js|min\.css|lock|map|snap)$|(^|\/)(dist|build|coverage|generated|vendor)\//i;

function parseRepo(repository: string): { owner: string; repo: string } {
	const [owner, repo] = repository.split("/");
	if (!owner || !repo) {
		throw new Error(`Invalid repository format: ${repository}`);
	}
	return { owner, repo };
}

export async function getChangedFiles(
	pr: PullRequestContext,
	context: ActionContext,
): Promise<string[]> {
	const { octokit, config, logger } = context;
	const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
		owner: pr.owner,
		repo: pr.repo,
		pull_number: pr.number,
		per_page: 100,
	});

	const filtered = files
		.filter((file: { status: string }) => file.status !== "removed")
		.filter((file: { filename: string }) => {
			if (!config.skip_generated_files) {
				return true;
			}
			return !GENERATED_FILE_PATTERN.test(file.filename);
		})
		.map((file: { filename: string }) => file.filename);

	logger.info(
		`Changed files (${filtered.length}): ${filtered.join(", ") || "none"}`,
	);
	return filtered;
}

export async function getCodeOwnersForFile(
	filePath: string,
	context: ActionContext,
): Promise<string[]> {
	return context.codeownersResolver.getCodeOwnersForFile(filePath);
}

export async function getCandidateReviewers(
	files: string[],
	context: ActionContext,
): Promise<string[]> {
	const { logger, codeownersResolver, candidateCoverage, fileDetails } =
		context;
	const allCandidates = new Set<string>();

	for (const filePath of files) {
		const owners = await codeownersResolver.getCodeOwnersForFile(filePath);
		if (!owners.length) {
			logger.info(`- ${filePath}: no CODEOWNERS match; skipping.`);
			continue;
		}

		fileDetails.set(filePath, {
			owners,
			selected: owners,
		});

		logger.info(
			`- ${filePath}: owners=[${owners.join(", ")}], used=[${owners.join(", ")}]`,
		);

		for (const candidate of owners) {
			allCandidates.add(candidate);
			candidateCoverage.set(
				candidate,
				(candidateCoverage.get(candidate) || 0) + 1,
			);
		}
	}

	return [...allCandidates];
}

export async function filterAssignableCandidates(
	candidates: string[],
	prAuthor: string,
	context: ActionContext,
): Promise<string[]> {
	const { octokit, owner, repo, config, logger } = context;

	const deduped = uniq(candidates);
	const filtered = deduped.filter((candidate) => {
		if (candidate === prAuthor) {
			return false;
		}
		if (config.exclude_users.includes(candidate)) {
			return false;
		}
		if (config.exclude_bots && isBotLogin(candidate)) {
			return false;
		}
		return true;
	});

	const assignable: string[] = [];
	for (const candidate of filtered) {
		try {
			await withRetry(
				() =>
					octokit.rest.repos.getCollaboratorPermissionLevel({
						owner,
						repo,
						username: candidate,
					}),
				{ logger },
			);
			assignable.push(candidate);
		} catch (error) {
			logger.info(
				`Skipping non-assignable candidate ${candidate}: ${error.message}`,
			);
		}
	}

	return assignable;
}

function scoreFromMetrics(metrics: ScoredReviewer["metrics"]): number {
	return metrics.activeReviews * 1.0 + metrics.avgPrSize * 0.3;
}

export async function getReviewerLoadScore(
	user: string,
	context: ActionContext,
): Promise<ScoredReviewer> {
	const { openPullRequests = [], logger, historicalFileReviewCounts } = context;
	let activeReviews = 0;
	const activePrSizes: number[] = [];

	for (const pr of openPullRequests) {
		const requestedReviewers =
			pr.requested_reviewers?.map(
				(reviewer: { login: string }) => reviewer.login,
			) ?? [];
		const isRequested = requestedReviewers.includes(user);

		if (isRequested) {
			activeReviews += 1;
			const size = (pr.additions || 0) + (pr.deletions || 0);
			activePrSizes.push(size);
		}
	}

	const avgPrSize =
		activePrSizes.length > 0
			? activePrSizes.reduce((sum, value) => sum + value, 0) /
				activePrSizes.length
			: 0;

	const metrics = {
		activeReviews: activeReviews,
		avgPrSize: avgPrSize,
		fileReviewCount: historicalFileReviewCounts.get(user) || 0,
	};

	const score = scoreFromMetrics(metrics);
	logger.info(
		`Score ${user}: active=${metrics.activeReviews}, avgSize=${metrics.avgPrSize.toFixed(1)}, fileReviews=${metrics.fileReviewCount} => ${score.toFixed(3)}`,
	);

	return { user, score, metrics };
}

export async function getHistoricalFileReviewCounts(
	changedFiles: string[],
	candidates: string[],
	currentPullNumber: number,
	context: ActionContext,
): Promise<Map<string, number>> {
	const {
		octokit,
		owner,
		repo,
		logger,
		config,
		openPullRequests = [],
	} = context;
	const counts = new Map<string, number>();
	const changedFilesSet = new Set(changedFiles);
	const candidateSet = new Set(candidates);
	const since = new Date(
		Date.now() - config.lookback_days * 24 * 60 * 60 * 1000,
	);

	for (const candidate of candidates) {
		counts.set(candidate, 0);
	}

	const closedPulls = await octokit.paginate(octokit.rest.pulls.list, {
		owner,
		repo,
		state: "closed",
		sort: "updated",
		direction: "desc",
		per_page: 100,
	});

	const pullsToInspect = [...openPullRequests, ...closedPulls].filter((pr) => {
		if (pr.number === currentPullNumber) {
			return false;
		}
		if (!pr.updated_at) {
			return true;
		}
		return new Date(pr.updated_at) >= since;
	});

	for (const pr of pullsToInspect) {
		const files = await withRetry(
			async () => {
				const items = await octokit.paginate(octokit.rest.pulls.listFiles, {
					owner,
					repo,
					pull_number: pr.number,
					per_page: 100,
				});
				return items.map((item: { filename: string }) => item.filename);
			},
			{ logger },
		);

		const hasOverlap = files.some((file: string) => changedFilesSet.has(file));
		if (!hasOverlap) {
			continue;
		}

		const reviews =
			pr.reviews ??
			(
				(await withRetry(
					() =>
						octokit.rest.pulls.listReviews({
							owner,
							repo,
							pull_number: pr.number,
							per_page: 100,
						}),
					{ logger },
				)) as any
			).data;

		const reviewersForPR = new Set<string>();
		for (const review of reviews) {
			const login = review.user?.login;
			if (!login || !candidateSet.has(login)) {
				continue;
			}
			reviewersForPR.add(login);
		}

		for (const login of reviewersForPR) {
			counts.set(login, (counts.get(login) || 0) + 1);
		}
	}

	return counts;
}

export function rankAndChooseReviewers(
	scoredCandidates: ScoredReviewer[],
	reviewerCount: number,
	rng = Math.random,
): ScoredReviewer[] {
	const groupedByScoreAndFileReviewCount = new Map<string, ScoredReviewer[]>();
	for (const item of scoredCandidates) {
		const key = `${item.score.toFixed(6)}:${item.metrics.fileReviewCount}`;
		if (!groupedByScoreAndFileReviewCount.has(key)) {
			groupedByScoreAndFileReviewCount.set(key, []);
		}
		groupedByScoreAndFileReviewCount.get(key)!.push(item);
	}

	const sortedKeys = [...groupedByScoreAndFileReviewCount.keys()].sort(
		(a, b) => {
			const [scoreA, fileReviewsA] = a.split(":").map(Number);
			const [scoreB, fileReviewsB] = b.split(":").map(Number);
			if (scoreA !== scoreB) {
				return scoreA - scoreB;
			}
			return fileReviewsB - fileReviewsA;
		},
	);

	const ranked: ScoredReviewer[] = [];
	for (const scoreKey of sortedKeys) {
		const items = groupedByScoreAndFileReviewCount.get(scoreKey)!;
		ranked.push(...shuffle(items, rng));
	}

	return ranked.slice(0, reviewerCount);
}

export async function assignReviewers(
	pr: PullRequestContext,
	reviewers: string[],
	context: ActionContext,
): Promise<string[]> {
	const { octokit, config, logger } = context;
	if (!reviewers.length) {
		logger.info("No reviewers to assign.");
		return [];
	}

	if (config.dry_run) {
		logger.info(`[dry-run] Would assign reviewers: ${reviewers.join(", ")}`);
		return reviewers;
	}

	await withRetry(
		() =>
			octokit.rest.pulls.requestReviewers({
				owner: pr.owner,
				repo: pr.repo,
				pull_number: pr.number,
				reviewers,
			}),
		{ logger },
	);

	logger.info(`Assigned reviewers: ${reviewers.join(", ")}`);
	return reviewers;
}

export async function loadOpenPullRequestsForScoring(
	context: ActionContext,
	currentPullNumber: number,
): Promise<any[]> {
	const { octokit, owner, repo, logger } = context;
	const openPullRequests = await octokit.paginate(octokit.rest.pulls.list, {
		owner,
		repo,
		state: "open",
		per_page: 100,
	});

	const enriched: any[] = [];
	for (const pr of openPullRequests) {
		if (pr.number === currentPullNumber) {
			continue;
		}

		const details: any = await withRetry(
			() =>
				octokit.rest.pulls.get({
					owner,
					repo,
					pull_number: pr.number,
				}),
			{ logger },
		);
		const reviews: any = await withRetry(
			() =>
				octokit.rest.pulls.listReviews({
					owner,
					repo,
					pull_number: pr.number,
					per_page: 100,
				}),
			{ logger },
		);

		enriched.push({
			...details.data,
			reviews: reviews.data,
		});
	}

	return enriched;
}

export function createPullRequestContext(
	eventPayload: any,
): PullRequestContext {
	const repository = eventPayload?.repository?.full_name;
	const pullRequest = eventPayload?.pull_request;
	if (!repository || !pullRequest) {
		throw new Error("Missing pull_request payload data.");
	}
	const { owner, repo } = parseRepo(repository);
	return {
		owner,
		repo,
		number: pullRequest.number,
		author: pullRequest.user?.login,
		requestedReviewers:
			pullRequest.requested_reviewers?.map(
				(reviewer: { login: string }) => reviewer.login,
			) ?? [],
	};
}
