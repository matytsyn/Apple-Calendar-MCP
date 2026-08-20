import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

export type LoggerOptions = {
  filePath?: string;
};

type LogLevel = "info" | "warn" | "error";

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata: metadata ?? {}
    });

    process.stderr.write(`${entry}\n`);

    if (options.filePath) {
      mkdirSync(dirname(options.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(options.filePath, `${entry}\n`, { mode: 0o600 });
    }
  };

  return {
    info: (message, metadata) => write("info", message, metadata),
    warn: (message, metadata) => write("warn", message, metadata),
    error: (message, metadata) => write("error", message, metadata)
  };
}
