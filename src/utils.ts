const BOT_NAME_PATTERN = /\[bot\]$|bot$/i;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function isBotLogin(login: string): boolean {
  return BOT_NAME_PATTERN.test(login);
}

export function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function intersection<T>(left: T[], right: T[]): T[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

export function shuffle<T>(values: T[], rng = Math.random): T[] {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withRetry<T>(
  action: () => Promise<T>,
  { retries = 3, logger = console as Logger }: { retries?: number; logger?: Logger } = {},
): Promise<T> {
  let attempt = 0;

  while (attempt <= retries) {
    try {
      return await action();
    } catch (error) {
      const status = error?.status;
      const resetHeader = error?.response?.headers?.["x-ratelimit-reset"];
      const shouldRetry = status === 403 || status === 429 || status >= 500;

      if (!shouldRetry || attempt === retries) {
        throw error;
      }

      let delayMs = 1000 * (attempt + 1);
      if (resetHeader) {
        const resetEpochSeconds = Number(resetHeader);
        if (!Number.isNaN(resetEpochSeconds)) {
          delayMs = Math.max(resetEpochSeconds * 1000 - Date.now(), 1000);
        }
      }

      logger.warn(
        `GitHub API call failed (status=${status ?? "unknown"}). Retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`,
      );
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw new Error("Retry loop exited unexpectedly");
}
