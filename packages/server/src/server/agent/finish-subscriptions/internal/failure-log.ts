import type { Logger } from "pino";

/**
 * Logs a check that keeps failing once when it starts failing, and once more when it answers
 * again. A followed child is checked every few seconds for up to a day, so a line per attempt
 * would bury everything else in the log.
 */
export function createFailureLog(logger: Pick<Logger, "warn" | "info">) {
  const failing = new Set<string>();
  return {
    failed(key: string, fields: object, message: string): void {
      if (failing.has(key)) return;
      failing.add(key);
      logger.warn(fields, message);
    },
    recovered(key: string, fields: object, message: string): void {
      if (failing.delete(key)) logger.info(fields, message);
    },
  };
}

export type FailureLog = ReturnType<typeof createFailureLog>;
