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
async function withRetry(action, {
  retries = 3,
  logger = console
} = {}) {
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
var CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS"
];
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
      const content = Buffer.from(response.data.content, "base64").toString(
        "utf8"
      );
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
      const expanded = await Promise.all(
        rawOwners.map((entry) => expandOwner(entry))
      );
      return [...new Set(expanded.flat())];
    }
  };
}

// src/config.ts
var import_js_yaml = __toESM(require("js-yaml"));
var DEFAULT_CONFIG = {
  reviewer_count: 2,
  lookback_days: 60,
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
      logger.warn(
        `Failed to read ${configPath}, using defaults: ${error2.message}`
      );
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
  logger.info(
    `Changed files (${filtered.length}): ${filtered.join(", ") || "none"}`
  );
  return filtered;
}
async function getCandidateReviewers(files, context2) {
  const { logger, codeownersResolver, candidateCoverage, fileDetails } = context2;
  const allCandidates = /* @__PURE__ */ new Set();
  for (const filePath of files) {
    const owners = await codeownersResolver.getCodeOwnersForFile(filePath);
    if (!owners.length) {
      logger.info(`- ${filePath}: no CODEOWNERS match; skipping.`);
      continue;
    }
    fileDetails.set(filePath, {
      owners,
      selected: owners
    });
    logger.info(
      `- ${filePath}: owners=[${owners.join(", ")}], used=[${owners.join(", ")}]`
    );
    for (const candidate of owners) {
      allCandidates.add(candidate);
      candidateCoverage.set(
        candidate,
        (candidateCoverage.get(candidate) || 0) + 1
      );
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
      logger.info(
        `Skipping non-assignable candidate ${candidate}: ${error2.message}`
      );
    }
  }
  return assignable;
}
function scoreFromMetrics(metrics) {
  return metrics.activeReviews * 1 + metrics.avgPrSize * 0.3;
}
async function getReviewerLoadScore(user, context2) {
  const { openPullRequests = [], logger, historicalFileReviewCounts } = context2;
  let activeReviews = 0;
  const activePrSizes = [];
  for (const pr of openPullRequests) {
    const requestedReviewers = pr.requested_reviewers?.map(
      (reviewer) => reviewer.login
    ) ?? [];
    const isRequested = requestedReviewers.includes(user);
    if (isRequested) {
      activeReviews += 1;
      const size = (pr.additions || 0) + (pr.deletions || 0);
      activePrSizes.push(size);
    }
  }
  const avgPrSize = activePrSizes.length > 0 ? activePrSizes.reduce((sum, value) => sum + value, 0) / activePrSizes.length : 0;
  const metrics = {
    activeReviews,
    avgPrSize,
    fileReviewCount: historicalFileReviewCounts.get(user) || 0
  };
  const score = scoreFromMetrics(metrics);
  logger.info(
    `Score ${user}: active=${metrics.activeReviews}, avgSize=${metrics.avgPrSize.toFixed(1)}, fileReviews=${metrics.fileReviewCount} => ${score.toFixed(3)}`
  );
  return { user, score, metrics };
}
async function getHistoricalFileReviewCounts(changedFiles, candidates, currentPullNumber, context2) {
  const {
    octokit,
    owner,
    repo,
    logger,
    config,
    openPullRequests = []
  } = context2;
  const counts = /* @__PURE__ */ new Map();
  const changedFilesSet = new Set(changedFiles);
  const candidateSet = new Set(candidates);
  const since = new Date(
    Date.now() - config.lookback_days * 24 * 60 * 60 * 1e3
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
    per_page: 100
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
          per_page: 100
        });
        return items.map((item) => item.filename);
      },
      { logger }
    );
    const hasOverlap = files.some((file) => changedFilesSet.has(file));
    if (!hasOverlap) {
      continue;
    }
    const reviews = pr.reviews ?? (await withRetry(
      () => octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100
      }),
      { logger }
    )).data;
    const reviewersForPR = /* @__PURE__ */ new Set();
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
function rankAndChooseReviewers(scoredCandidates, reviewerCount, rng = Math.random) {
  const groupedByScoreAndFileReviewCount = /* @__PURE__ */ new Map();
  for (const item of scoredCandidates) {
    const key = `${item.score.toFixed(6)}:${item.metrics.fileReviewCount}`;
    if (!groupedByScoreAndFileReviewCount.has(key)) {
      groupedByScoreAndFileReviewCount.set(key, []);
    }
    groupedByScoreAndFileReviewCount.get(key).push(item);
  }
  const sortedKeys = [...groupedByScoreAndFileReviewCount.keys()].sort(
    (a, b) => {
      const [scoreA, fileReviewsA] = a.split(":").map(Number);
      const [scoreB, fileReviewsB] = b.split(":").map(Number);
      if (scoreA !== scoreB) {
        return scoreA - scoreB;
      }
      return fileReviewsB - fileReviewsA;
    }
  );
  const ranked = [];
  for (const scoreKey of sortedKeys) {
    const items = groupedByScoreAndFileReviewCount.get(scoreKey);
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
    requestedReviewers: pullRequest.requested_reviewers?.map(
      (reviewer) => reviewer.login
    ) ?? []
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
    "Selection logic: CODEOWNERS + historical file reviewers + load balancing."
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
  const config = await loadConfig(
    octokit,
    pr.owner,
    pr.repo,
    logger,
    configPath
  );
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
    candidateCoverage: /* @__PURE__ */ new Map(),
    fileDetails: /* @__PURE__ */ new Map(),
    codeownersResolver: {
      getCodeOwnersForFile: async (_filePath) => []
    },
    openPullRequests: [],
    historicalFileReviewCounts: /* @__PURE__ */ new Map()
  };
  const changedFiles = await getChangedFiles(pr, context2);
  if (!changedFiles.length) {
    logger.info("No changed files found after filtering.");
    return;
  }
  context2.codeownersResolver = await createCodeownersResolver(
    octokit,
    pr.owner,
    pr.repo,
    logger
  );
  const candidates = await getCandidateReviewers(changedFiles, context2);
  logger.info(`Candidate pool before filtering: [${candidates.join(", ")}]`);
  const assignableCandidates = await filterAssignableCandidates(
    candidates,
    pr.author,
    context2
  );
  logger.info(
    `Candidate pool after filtering: [${assignableCandidates.join(", ")}]`
  );
  if (!assignableCandidates.length) {
    logger.warn("No assignable candidates found.");
    return;
  }
  context2.openPullRequests = await loadOpenPullRequestsForScoring(
    context2,
    pr.number
  );
  context2.historicalFileReviewCounts = await getHistoricalFileReviewCounts(
    changedFiles,
    assignableCandidates,
    pr.number,
    context2
  );
  const scored = [];
  for (const candidate of assignableCandidates) {
    scored.push(await getReviewerLoadScore(candidate, context2));
  }
  const chosen = rankAndChooseReviewers(scored, config.reviewer_count).map(
    (item) => item.user
  );
  logger.info(`Final reviewers: [${chosen.join(", ")}]`);
  await assignReviewers(pr, chosen, context2);
  await maybeLeaveComment(pr, chosen, context2);
}
if (require.main === module) {
  run().catch((error2) => {
    core.setFailed(
      `Failed to assign reviewers: ${error2?.stack || error2?.message || error2}`
    );
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});
