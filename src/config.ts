import yaml from "js-yaml";
import type { Logger } from "./utils";

export interface ReviewerAssignmentConfig {
  reviewer_count: number;
  lookback_days: number;
  recent_editors_limit: number;
  exclude_users: string[];
  exclude_bots: boolean;
  dry_run: boolean;
  skip_if_reviewers_already_assigned: boolean;
  skip_generated_files: boolean;
  leave_comment: boolean;
}

export const DEFAULT_CONFIG: ReviewerAssignmentConfig = {
  reviewer_count: 2,
  lookback_days: 60,
  recent_editors_limit: 3,
  exclude_users: [],
  exclude_bots: true,
  dry_run: false,
  skip_if_reviewers_already_assigned: true,
  skip_generated_files: true,
  leave_comment: false,
};

function normalizeConfig(rawConfig: Partial<ReviewerAssignmentConfig> | undefined): ReviewerAssignmentConfig {
  const merged = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  return {
    ...merged,
    reviewer_count: Number(merged.reviewer_count) || DEFAULT_CONFIG.reviewer_count,
    lookback_days: Number(merged.lookback_days) || DEFAULT_CONFIG.lookback_days,
    recent_editors_limit:
      Number(merged.recent_editors_limit) || DEFAULT_CONFIG.recent_editors_limit,
    exclude_users: Array.isArray(merged.exclude_users) ? merged.exclude_users : [],
  };
}

function decodeFileContent(content: string): string {
  return Buffer.from(content, "base64").toString("utf8");
}

export async function loadConfig(
  octokit: any,
  owner: string,
  repo: string,
  logger: Logger,
  configPath: string,
): Promise<ReviewerAssignmentConfig> {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
    });

    if (Array.isArray(response.data) || !("content" in response.data)) {
      logger.warn(`Config path ${configPath} is not a file. Using defaults.`);
      return normalizeConfig({});
    }

    const content = decodeFileContent(response.data.content);
    const parsed = yaml.load(content) as Partial<ReviewerAssignmentConfig>;
    const config = normalizeConfig(parsed);
    logger.info(`Loaded config from ${configPath}`);
    return config;
  } catch (error) {
    if (error?.status !== 404) {
      logger.warn(`Failed to read ${configPath}, using defaults: ${error.message}`);
    } else {
      logger.info(`No ${configPath} found. Using defaults.`);
    }
    return normalizeConfig({});
  }
}
