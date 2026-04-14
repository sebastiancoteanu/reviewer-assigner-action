var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  run: () => run
});
module.exports = __toCommonJS(main_exports);
var core = __toESM(require("@actions/core"));
var github = __toESM(require("@actions/github"));

// src/codeowners.ts
var import_minimatch = require("minimatch");

// src/utils.ts
var BOT_NAME_PATTERN = /\[bot\]$|bot$/i;
function isBotLogin(login) {
  return BOT_NAME_PATTERN.test(login);
}
function uniq(values) {
  return [...new Set(values)];
}
function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}
function shuffle(values, rng = Math.random) {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}
async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
async function withRetry(action, { retries = 3, logger = console } = {}) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await action();
    } catch (error2) {
      const status = error2?.status;
      const resetHeader = error2?.response?.headers?.["x-ratelimit-reset"];
      const shouldRetry = status === 403 || status === 429 || status >= 500;
      if (!shouldRetry || attempt === retries) {
        throw error2;
      }
      let delayMs = 1e3 * (attempt + 1);
      if (resetHeader) {
        const resetEpochSeconds = Number(resetHeader);
        if (!Number.isNaN(resetEpochSeconds)) {
          delayMs = Math.max(resetEpochSeconds * 1e3 - Date.now(), 1e3);
        }
      }
      logger.warn(
        `GitHub API call failed (status=${status ?? "unknown"}). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`
      );
      await sleep(delayMs);
      attempt += 1;
    }
  }
  throw new Error("Retry loop exited unexpectedly");
}

// src/codeowners.ts
var CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
function stripComment(line) {
  const index = line.indexOf("#");
  if (index === -1) {
    return line;
  }
  return line.slice(0, index);
}
function parseCodeowners(content) {
  return content.split(/\r?\n/).map((line) => stripComment(line).trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    return {
      pattern: parts[0],
      owners: parts.slice(1)
    };
  }).filter((rule) => Boolean(rule));
}
function normalizePattern(pattern) {
  if (pattern.startsWith("/")) {
    return pattern.slice(1);
  }
  return pattern;
}
function matchPattern(filePath, rawPattern) {
  const pattern = normalizePattern(rawPattern);
  const normalizedPath = filePath.replace(/^\//, "");
  if (pattern.endsWith("/")) {
    return normalizedPath.startsWith(pattern);
  }
  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
    return (0, import_minimatch.minimatch)(normalizedPath, pattern, { dot: true, nocase: false });
  }
  return normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`);
}
function getOwnersForFile(filePath, rules) {
  let matchedOwners = [];
  for (const rule of rules) {
    if (matchPattern(filePath, rule.pattern)) {
      matchedOwners = rule.owners;
    }
  }
  return matchedOwners;
}
async function getCodeownersContent(octokit, owner, repo, logger) {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const response = await withRetry(
        () => octokit.rest.repos.getContent({ owner, repo, path }),
        { logger }
      );
      if (Array.isArray(response.data) || !("content" in response.data)) {
        continue;
      }
      const content = Buffer.from(response.data.content, "base64").toString("utf8");
      return { content, path };
    } catch (error2) {
      if (error2?.status !== 404) {
        throw error2;
      }
    }
  }
  return null;
}
async function resolveTeamMembers(octokit, owner, repo, teamOwner, teamSlug, logger) {
  const org = teamOwner || owner;
  try {
    const response = await withRetry(
      () => octokit.rest.teams.listMembersInOrg({
        org,
        team_slug: teamSlug,
        per_page: 100
      }),
      { logger }
    );
    return response.data.map((member) => member.login);
  } catch (error2) {
    logger.warn(
      `Unable to expand team ${teamOwner}/${teamSlug} from CODEOWNERS for ${owner}/${repo}: ${error2.message}`
    );
    return [];
  }
}
async function createCodeownersResolver(octokit, owner, repo, logger) {
  const loaded = await getCodeownersContent(octokit, owner, repo, logger);
  if (!loaded) {
    logger.warn("No CODEOWNERS file found.");
    return {
      path: null,
      getCodeOwnersForFile: async () => []
    };
  }
  logger.info(`Using CODEOWNERS from ${loaded.path}`);
  const rules = parseCodeowners(loaded.content);
  const teamCache = /* @__PURE__ */ new Map();
  async function expandOwner(ownerToken) {
    if (!ownerToken.startsWith("@")) {
      return [];
    }
    const raw = ownerToken.slice(1);
    const segments = raw.split("/").filter(Boolean);
    if (segments.length === 1) {
      return [segments[0]];
    }
    if (segments.length !== 2) {
      return [];
    }
    const [teamOwner, teamSlug] = segments;
    const cacheKey = `${teamOwner}/${teamSlug}`;
    if (!teamCache.has(cacheKey)) {
      teamCache.set(
        cacheKey,
        resolveTeamMembers(octokit, owner, repo, teamOwner, teamSlug, logger)
      );
    }
    return teamCache.get(cacheKey);
  }
  return {
    path: loaded.path,
    async getCodeOwnersForFile(filePath) {
      const rawOwners = getOwnersForFile(filePath, rules);
      const expanded = await Promise.all(rawOwners.map((entry) => expandOwner(entry)));
      return [...new Set(expanded.flat())];
    }
  };
}

// src/config.ts
var import_js_yaml = __toESM(require("js-yaml"));
var DEFAULT_CONFIG = {
  reviewer_count: 2,
  lookback_days: 60,
  recent_editors_limit: 3,
  exclude_users: [],
  exclude_bots: true,
  dry_run: false,
  skip_if_reviewers_already_assigned: true,
  skip_generated_files: true,
  leave_comment: false
};
function normalizeConfig(rawConfig) {
  const merged = { ...DEFAULT_CONFIG, ...rawConfig ?? {} };
  return {
    ...merged,
    reviewer_count: Number(merged.reviewer_count) || DEFAULT_CONFIG.reviewer_count,
    lookback_days: Number(merged.lookback_days) || DEFAULT_CONFIG.lookback_days,
    recent_editors_limit: Number(merged.recent_editors_limit) || DEFAULT_CONFIG.recent_editors_limit,
    exclude_users: Array.isArray(merged.exclude_users) ? merged.exclude_users : []
  };
}
function decodeFileContent(content) {
  return Buffer.from(content, "base64").toString("utf8");
}
async function loadConfig(octokit, owner, repo, logger, configPath) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath
    });
    if (Array.isArray(response.data) || !("content" in response.data)) {
      logger.warn(`Config path ${configPath} is not a file. Using defaults.`);
      return normalizeConfig({});
    }
    const content = decodeFileContent(response.data.content);
    const parsed = import_js_yaml.default.load(content);
    const config = normalizeConfig(parsed);
    logger.info(`Loaded config from ${configPath}`);
    return config;
  } catch (error2) {
    if (error2?.status !== 404) {
      logger.warn(`Failed to read ${configPath}, using defaults: ${error2.message}`);
    } else {
      logger.info(`No ${configPath} found. Using defaults.`);
    }
    return normalizeConfig({});
  }
}

// src/reviewer-assignment.ts
var GENERATED_FILE_PATTERN = /\.(min\.js|min\.css|lock|map|snap)$|(^|\/)(dist|build|coverage|generated|vendor)\//i;
function parseRepo(repository) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repository format: ${repository}`);
  }
  return { owner, repo };
}
async function getChangedFiles(pr, context2) {
  const { octokit, config, logger } = context2;
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    per_page: 100
  });
  const filtered = files.filter((file) => file.status !== "removed").filter((file) => {
    if (!config.skip_generated_files) {
      return true;
    }
    return !GENERATED_FILE_PATTERN.test(file.filename);
  }).map((file) => file.filename);
  logger.info(`Changed files (${filtered.length}): ${filtered.join(", ") || "none"}`);
  return filtered;
}
async function getRecentEditorsForFile(filePath, days = 60, context2) {
  const { octokit, owner, repo, config, logger, commitStatsCache } = context2;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1e3).toISOString();
  const commits = await octokit.paginate(octokit.rest.repos.listCommits, {
    owner,
    repo,
    path: filePath,
    since,
    per_page: 100
  });
  const changedLinesByAuthor = /* @__PURE__ */ new Map();
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
          () => octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: commit.sha
          }),
          { logger }
        )
      );
    }
    const commitDetail = await commitStatsCache.get(commit.sha);
    const fileStats = commitDetail.data.files?.find(
      (item) => item.filename === filePath
    );
    if (!fileStats) {
      continue;
    }
    const changedLines = (fileStats.additions || 0) + (fileStats.deletions || 0);
    changedLinesByAuthor.set(login, (changedLinesByAuthor.get(login) || 0) + changedLines);
  }
  return [...changedLinesByAuthor.entries()].sort((a, b) => b[1] - a[1]).slice(0, config.recent_editors_limit).map(([login]) => login);
}
async function getCandidateReviewers(files, context2) {
  const {
    config,
    logger,
    codeownersResolver,
    recentEditorsCache,
    candidateCoverage,
    fileDetails
  } = context2;
  const allCandidates = /* @__PURE__ */ new Set();
  for (const filePath of files) {
    const owners = await codeownersResolver.getCodeOwnersForFile(filePath);
    if (!owners.length) {
      logger.info(`- ${filePath}: no CODEOWNERS match; skipping.`);
      continue;
    }
    if (!recentEditorsCache.has(filePath)) {
      recentEditorsCache.set(
        filePath,
        getRecentEditorsForFile(filePath, config.lookback_days, context2)
      );
    }
    const recentEditors = await recentEditorsCache.get(filePath);
    const strictCandidates = intersection(owners, recentEditors);
    const selected = strictCandidates.length ? strictCandidates : owners;
    fileDetails.set(filePath, {
      owners,
      recentEditors,
      strictCandidates,
      selected
    });
    logger.info(
      `- ${filePath}: owners=[${owners.join(", ")}], recent=[${recentEditors.join(", ")}], strict=[${strictCandidates.join(", ")}], used=[${selected.join(", ")}]`
    );
    for (const candidate of selected) {
      allCandidates.add(candidate);
      candidateCoverage.set(candidate, (candidateCoverage.get(candidate) || 0) + 1);
    }
  }
  return [...allCandidates];
}
async function filterAssignableCandidates(candidates, prAuthor, context2) {
  const { octokit, owner, repo, config, logger } = context2;
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
  const assignable = [];
  for (const candidate of filtered) {
    try {
      await withRetry(
        () => octokit.rest.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username: candidate
        }),
        { logger }
      );
      assignable.push(candidate);
    } catch (error2) {
      logger.info(`Skipping non-assignable candidate ${candidate}: ${error2.message}`);
    }
  }
  return assignable;
}
function scoreFromMetrics(metrics) {
  return metrics.active_reviews * 1 + metrics.recent_reviews_24h * 0.5 + metrics.avg_pr_size * 0.3;
}
async function getReviewerLoadScore(user, context2) {
  const { openPullRequests = [], logger } = context2;
  const now = Date.now();
  let activeReviews = 0;
  let recentReviews24h = 0;
  const activePrSizes = [];
  for (const pr of openPullRequests) {
    const requestedReviewers = pr.requested_reviewers?.map((reviewer) => reviewer.login) ?? [];
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
      if (ageMs <= 24 * 60 * 60 * 1e3) {
        recentReviews24h += 1;
      }
    }
  }
  const avgPrSize = activePrSizes.length > 0 ? activePrSizes.reduce((sum, value) => sum + value, 0) / activePrSizes.length : 0;
  const metrics = {
    active_reviews: activeReviews,
    recent_reviews_24h: recentReviews24h,
    avg_pr_size: avgPrSize
  };
  const score = scoreFromMetrics(metrics);
  logger.info(
    `Score ${user}: active=${metrics.active_reviews}, recent24h=${metrics.recent_reviews_24h}, avgSize=${metrics.avg_pr_size.toFixed(1)} => ${score.toFixed(3)}`
  );
  return { user, score, metrics };
}
function rankAndChooseReviewers(scoredCandidates, reviewerCount, rng = Math.random) {
  const groupedByScore = /* @__PURE__ */ new Map();
  for (const item of scoredCandidates) {
    const key = item.score.toFixed(6);
    if (!groupedByScore.has(key)) {
      groupedByScore.set(key, []);
    }
    groupedByScore.get(key).push(item);
  }
  const sortedScores = [...groupedByScore.keys()].map(Number).sort((a, b) => a - b).map((value) => value.toFixed(6));
  const ranked = [];
  for (const scoreKey of sortedScores) {
    const items = groupedByScore.get(scoreKey);
    ranked.push(...shuffle(items, rng));
  }
  return ranked.slice(0, reviewerCount);
}
async function assignReviewers(pr, reviewers, context2) {
  const { octokit, config, logger } = context2;
  if (!reviewers.length) {
    logger.info("No reviewers to assign.");
    return [];
  }
  if (config.dry_run) {
    logger.info(`[dry-run] Would assign reviewers: ${reviewers.join(", ")}`);
    return reviewers;
  }
  await withRetry(
    () => octokit.rest.pulls.requestReviewers({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      reviewers
    }),
    { logger }
  );
  logger.info(`Assigned reviewers: ${reviewers.join(", ")}`);
  return reviewers;
}
async function loadOpenPullRequestsForScoring(context2, currentPullNumber) {
  const { octokit, owner, repo, logger } = context2;
  const openPullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100
  });
  const enriched = [];
  for (const pr of openPullRequests) {
    if (pr.number === currentPullNumber) {
      continue;
    }
    const details = await withRetry(
      () => octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pr.number
      }),
      { logger }
    );
    const reviews = await withRetry(
      () => octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100
      }),
      { logger }
    );
    enriched.push({
      ...details.data,
      reviews: reviews.data
    });
  }
  return enriched;
}
function createPullRequestContext(eventPayload) {
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
    requestedReviewers: pullRequest.requested_reviewers?.map((reviewer) => reviewer.login) ?? []
  };
}

// src/main.ts
function createLogger() {
  return {
    info(message) {
      core.info(message);
    },
    warn(message) {
      core.warning(message);
    },
    error(message) {
      core.error(message);
    }
  };
}
async function maybeLeaveComment(pr, reviewers, context2) {
  const { config, logger, octokit } = context2;
  if (!config.leave_comment || !reviewers.length || config.dry_run) {
    return;
  }
  const body = [
    "Auto-assigned reviewers:",
    "",
    ...reviewers.map((reviewer) => `- @${reviewer}`),
    "",
    "Selection logic: CODEOWNERS + recent editors + load balancing."
  ].join("\n");
  await octokit.rest.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    body
  });
  logger.info("Posted assignment comment.");
}
async function run() {
  const logger = createLogger();
  const token = core.getInput("github-token", { required: true });
  const configPath = core.getInput("config-path") || ".github/reviewer-assignment.yml";
  const octokit = github.getOctokit(token);
  const eventPayload = github.context.payload;
  const pr = createPullRequestContext(eventPayload);
  const config = await loadConfig(octokit, pr.owner, pr.repo, logger, configPath);
  if (config.skip_if_reviewers_already_assigned && pr.requestedReviewers.length > 0) {
    logger.info(
      `Skipping: PR already has requested reviewers [${pr.requestedReviewers.join(", ")}]`
    );
    return;
  }
  const context2 = {
    octokit,
    owner: pr.owner,
    repo: pr.repo,
    config,
    logger,
    commitStatsCache: /* @__PURE__ */ new Map(),
    recentEditorsCache: /* @__PURE__ */ new Map(),
    candidateCoverage: /* @__PURE__ */ new Map(),
    fileDetails: /* @__PURE__ */ new Map(),
    codeownersResolver: {
      getCodeOwnersForFile: async (_filePath) => []
    },
    openPullRequests: []
  };
  const changedFiles = await getChangedFiles(pr, context2);
  if (!changedFiles.length) {
    logger.info("No changed files found after filtering.");
    return;
  }
  context2.codeownersResolver = await createCodeownersResolver(octokit, pr.owner, pr.repo, logger);
  const candidates = await getCandidateReviewers(changedFiles, context2);
  logger.info(`Candidate pool before filtering: [${candidates.join(", ")}]`);
  const assignableCandidates = await filterAssignableCandidates(candidates, pr.author, context2);
  logger.info(`Candidate pool after filtering: [${assignableCandidates.join(", ")}]`);
  if (!assignableCandidates.length) {
    logger.warn("No assignable candidates found.");
    return;
  }
  context2.openPullRequests = await loadOpenPullRequestsForScoring(context2, pr.number);
  const scored = [];
  for (const candidate of assignableCandidates) {
    scored.push(await getReviewerLoadScore(candidate, context2));
  }
  const chosen = rankAndChooseReviewers(scored, config.reviewer_count).map((item) => item.user);
  logger.info(`Final reviewers: [${chosen.join(", ")}]`);
  await assignReviewers(pr, chosen, context2);
  await maybeLeaveComment(pr, chosen, context2);
}
if (require.main === module) {
  run().catch((error2) => {
    core.setFailed(`Failed to assign reviewers: ${error2?.stack || error2?.message || error2}`);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});
