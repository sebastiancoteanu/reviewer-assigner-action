import type { ReviewerAssignmentConfig } from "./config";
import { intersection, isBotLogin, shuffle, uniq, withRetry, type Logger } from "./utils";

const GENERATED_FILE_PATTERN =
  /\.(min\.js|min\.css|lock|map|snap)$|(^|\/)(dist|build|coverage|generated|vendor)\//i;

interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  author: string;
  requestedReviewers: string[];
}

interface ActionContext {
  octokit: any;
  owner: string;
  repo: string;
  config: ReviewerAssignmentConfig;
  logger: Logger;
  commitStatsCache: Map<string, Promise<any>>;
  recentEditorsCache: Map<string, Promise<string[]>>;
  candidateCoverage: Map<string, number>;
  fileDetails: Map<string, unknown>;
  codeownersResolver: {
    getCodeOwnersForFile(filePath: string): Promise<string[]>;
  };
  openPullRequests?: any[];
}

interface ScoredReviewer {
  user: string;
  score: number;
  metrics: {
    active_reviews: number;
    recent_reviews_24h: number;
    avg_pr_size: number;
  };
}

function parseRepo(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository format: ${repository}`);
  }
  return { owner, repo };
}

export async function getChangedFiles(pr: PullRequestContext, context: ActionContext): Promise<string[]> {
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

  logger.info(`Changed files (${filtered.length}): ${filtered.join(", ") || "none"}`);
  return filtered;
}

export async function getCodeOwnersForFile(
  filePath: string,
  context: ActionContext,
): Promise<string[]> {
  return context.codeownersResolver.getCodeOwnersForFile(filePath);
}

export async function getRecentEditorsForFile(
  filePath: string,
  days = 60,
  context: ActionContext,
): Promise<string[]> {
  const { octokit, owner, repo, config, logger, commitStatsCache } = context;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
    owner,
    repo,
    path: filePath,
    since,
    per_page: 100,
  });

  const changedLinesByAuthor = new Map<string, number>();

  for (const commit of commits) {
    const login = commit.author?.login || commit.committer?.login;
    if (!login) {
      continue;
    }

    if (config.exclude_bots && isBotLogin(login)) {
      continue;
    }

    if (!commitStatsCache.has(commit.sha)) {
      commitStatsCache.set(
        commit.sha,
        withRetry(
          () =>
            octokit.rest.repos.getCommit({
              owner,
              repo,
              ref: commit.sha,
            }),
          { logger },
        ),
      );
    }

    const commitDetail = await commitStatsCache.get(commit.sha)!;
    const fileStats = commitDetail.data.files?.find(
      (item: { filename: string }) => item.filename === filePath,
    );
    if (!fileStats) {
      continue;
    }

    const changedLines = (fileStats.additions || 0) + (fileStats.deletions || 0);
    changedLinesByAuthor.set(login, (changedLinesByAuthor.get(login) || 0) + changedLines);
  }

  return [...changedLinesByAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.recent_editors_limit)
    .map(([login]) => login);
}

export async function getCandidateReviewers(
  files: string[],
  context: ActionContext,
): Promise<string[]> {
  const {
    config,
    logger,
    codeownersResolver,
    recentEditorsCache,
    candidateCoverage,
    fileDetails,
  } = context;
  const allCandidates = new Set<string>();

  for (const filePath of files) {
    const owners = await codeownersResolver.getCodeOwnersForFile(filePath);
    if (!owners.length) {
      logger.info(`- ${filePath}: no CODEOWNERS match; skipping.`);
      continue;
    }

    if (!recentEditorsCache.has(filePath)) {
      recentEditorsCache.set(
        filePath,
        getRecentEditorsForFile(filePath, config.lookback_days, context),
      );
    }
    const recentEditors = await recentEditorsCache.get(filePath)!;

    const strictCandidates = intersection(owners, recentEditors);
    const selected = strictCandidates.length ? strictCandidates : owners;

    fileDetails.set(filePath, {
      owners,
      recentEditors,
      strictCandidates,
      selected,
    });

    logger.info(
      `- ${filePath}: owners=[${owners.join(", ")}], recent=[${recentEditors.join(", ")}], strict=[${strictCandidates.join(", ")}], used=[${selected.join(", ")}]`,
    );

    for (const candidate of selected) {
      allCandidates.add(candidate);
      candidateCoverage.set(candidate, (candidateCoverage.get(candidate) || 0) + 1);
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
      logger.info(`Skipping non-assignable candidate ${candidate}: ${error.message}`);
    }
  }

  return assignable;
}

function scoreFromMetrics(metrics: ScoredReviewer["metrics"]): number {
  return (
    metrics.active_reviews * 1.0 +
    metrics.recent_reviews_24h * 0.5 +
    metrics.avg_pr_size * 0.3
  );
}

export async function getReviewerLoadScore(
  user: string,
  context: ActionContext,
): Promise<ScoredReviewer> {
  const { openPullRequests = [], logger } = context;
  const now = Date.now();
  let activeReviews = 0;
  let recentReviews24h = 0;
  const activePrSizes: number[] = [];

  for (const pr of openPullRequests) {
    const requestedReviewers =
      pr.requested_reviewers?.map((reviewer: { login: string }) => reviewer.login) ?? [];
    const isRequested = requestedReviewers.includes(user);

    if (isRequested) {
      activeReviews += 1;
      const size = (pr.additions || 0) + (pr.deletions || 0);
      activePrSizes.push(size);
    }

    const reviews = pr.reviews || [];
    for (const review of reviews) {
      if (review.user?.login !== user || !review.submitted_at) {
        continue;
      }
      const ageMs = now - new Date(review.submitted_at).getTime();
      if (ageMs <= 24 * 60 * 60 * 1000) {
        recentReviews24h += 1;
      }
    }
  }

  const avgPrSize =
    activePrSizes.length > 0
      ? activePrSizes.reduce((sum, value) => sum + value, 0) / activePrSizes.length
      : 0;

  const metrics = {
    active_reviews: activeReviews,
    recent_reviews_24h: recentReviews24h,
    avg_pr_size: avgPrSize,
  };

  const score = scoreFromMetrics(metrics);
  logger.info(
    `Score ${user}: active=${metrics.active_reviews}, recent24h=${metrics.recent_reviews_24h}, avgSize=${metrics.avg_pr_size.toFixed(1)} => ${score.toFixed(3)}`,
  );

  return { user, score, metrics };
}

export function rankAndChooseReviewers(
  scoredCandidates: ScoredReviewer[],
  reviewerCount: number,
  rng = Math.random,
): ScoredReviewer[] {
  const groupedByScore = new Map<string, ScoredReviewer[]>();
  for (const item of scoredCandidates) {
    const key = item.score.toFixed(6);
    if (!groupedByScore.has(key)) {
      groupedByScore.set(key, []);
    }
    groupedByScore.get(key)!.push(item);
  }

  const sortedScores = [...groupedByScore.keys()]
    .map(Number)
    .sort((a, b) => a - b)
    .map((value) => value.toFixed(6));

  const ranked: ScoredReviewer[] = [];
  for (const scoreKey of sortedScores) {
    const items = groupedByScore.get(scoreKey)!;
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

export function createPullRequestContext(eventPayload: any): PullRequestContext {
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
      pullRequest.requested_reviewers?.map((reviewer: { login: string }) => reviewer.login) ?? [],
  };
}
