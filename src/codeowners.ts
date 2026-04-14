import { minimatch } from "minimatch";
import type { Logger } from "./utils";
import { withRetry } from "./utils";

const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

interface CodeownersRule {
  pattern: string;
  owners: string[];
}

function stripComment(line: string): string {
  const index = line.indexOf("#");
  if (index === -1) {
    return line;
  }
  return line.slice(0, index);
}

export function parseCodeowners(content: string): CodeownersRule[] {
  return content
    .split(/\r?\n/)
    .map((line) => stripComment(line).trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        return null;
      }
      return {
        pattern: parts[0],
        owners: parts.slice(1),
      };
    })
    .filter((rule): rule is CodeownersRule => Boolean(rule));
}

function normalizePattern(pattern: string): string {
  if (pattern.startsWith("/")) {
    return pattern.slice(1);
  }
  return pattern;
}

function matchPattern(filePath: string, rawPattern: string): boolean {
  const pattern = normalizePattern(rawPattern);
  const normalizedPath = filePath.replace(/^\//, "");

  if (pattern.endsWith("/")) {
    return normalizedPath.startsWith(pattern);
  }

  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
    return minimatch(normalizedPath, pattern, { dot: true, nocase: false });
  }

  return normalizedPath === pattern || normalizedPath.startsWith(`${pattern}/`);
}

export function getOwnersForFile(filePath: string, rules: CodeownersRule[]): string[] {
  let matchedOwners: string[] = [];
  for (const rule of rules) {
    if (matchPattern(filePath, rule.pattern)) {
      matchedOwners = rule.owners;
    }
  }
  return matchedOwners;
}

async function getCodeownersContent(
  octokit: any,
  owner: string,
  repo: string,
  logger: Logger,
): Promise<{ content: string; path: string } | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const response: any = await withRetry(
        () => octokit.rest.repos.getContent({ owner, repo, path }),
        { logger },
      );
      if (Array.isArray(response.data) || !("content" in response.data)) {
        continue;
      }
      const content = Buffer.from(response.data.content, "base64").toString("utf8");
      return { content, path };
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
  }

  return null;
}

async function resolveTeamMembers(
  octokit: any,
  owner: string,
  repo: string,
  teamOwner: string,
  teamSlug: string,
  logger: Logger,
): Promise<string[]> {
  const org = teamOwner || owner;
  try {
    const response: any = await withRetry(
      () =>
        octokit.rest.teams.listMembersInOrg({
          org,
          team_slug: teamSlug,
          per_page: 100,
        }),
      { logger },
    );
    return response.data.map((member: { login: string }) => member.login);
  } catch (error) {
    logger.warn(
      `Unable to expand team ${teamOwner}/${teamSlug} from CODEOWNERS for ${owner}/${repo}: ${error.message}`,
    );
    return [];
  }
}

export async function createCodeownersResolver(
  octokit: any,
  owner: string,
  repo: string,
  logger: Logger,
) {
  const loaded = await getCodeownersContent(octokit, owner, repo, logger);
  if (!loaded) {
    logger.warn("No CODEOWNERS file found.");
    return {
      path: null,
      getCodeOwnersForFile: async () => [] as string[],
    };
  }

  logger.info(`Using CODEOWNERS from ${loaded.path}`);
  const rules = parseCodeowners(loaded.content);
  const teamCache = new Map<string, Promise<string[]>>();

  async function expandOwner(ownerToken: string): Promise<string[]> {
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
        resolveTeamMembers(octokit, owner, repo, teamOwner, teamSlug, logger),
      );
    }

    return teamCache.get(cacheKey)!;
  }

  return {
    path: loaded.path,
    async getCodeOwnersForFile(filePath: string): Promise<string[]> {
      const rawOwners = getOwnersForFile(filePath, rules);
      const expanded = await Promise.all(rawOwners.map((entry) => expandOwner(entry)));
      return [...new Set(expanded.flat())];
    },
  };
}
