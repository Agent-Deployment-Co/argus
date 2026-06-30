import { inspect } from "node:util";
import { createConsola, type ConsolaReporter, type LogLevel as ConsolaLogLevel, type LogObject, type LogType } from "consola";

export const ARGUS_LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type ArgusLogLevel = (typeof ARGUS_LOG_LEVELS)[number];

type Writable = { write(chunk: string): unknown };

const LEVEL_NUMBERS: Record<ArgusLogLevel, ConsolaLogLevel> = {
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
};

const TYPE_LEVELS: Partial<Record<LogType, ArgusLogLevel>> = {
  fatal: "error",
  error: "error",
  fail: "error",
  warn: "warn",
  log: "info",
  info: "info",
  success: "info",
  ready: "info",
  start: "info",
  box: "info",
  debug: "debug",
  trace: "trace",
};

export interface Log {
  (message: string): void;
  error?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
  trace?: (message: string, ...args: unknown[]) => void;
  setLevel?: (level: ArgusLogLevel) => void;
  getLevel?: () => ArgusLogLevel;
}

export interface CreateLoggerOptions {
  level?: ArgusLogLevel;
  stream?: Writable;
}

export function normalizeLogLevel(value: unknown): ArgusLogLevel | undefined {
  const raw = String(value).trim().toLowerCase();
  if (raw === "warning") return "warn";
  return (ARGUS_LOG_LEVELS as readonly string[]).includes(raw) ? (raw as ArgusLogLevel) : undefined;
}

function levelForObject(logObj: LogObject): ArgusLogLevel {
  const byType = TYPE_LEVELS[logObj.type];
  if (byType) return byType;
  const level = Number(logObj.level);
  if (level <= 0) return "error";
  if (level === 1) return "warn";
  if (level <= 3) return "info";
  if (level === 4) return "debug";
  return "trace";
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return inspect(value, { colors: false, compact: true, depth: 6, breakLength: Infinity });
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

function timestampReporter(stream: Writable): ConsolaReporter {
  return {
    log(logObj) {
      const level = levelForObject(logObj);
      const label = level.toUpperCase().padEnd(5, " ");
      const text = formatArgs(logObj.args);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        stream.write(`${logObj.date.toISOString()} ${label} ${line}\n`);
      }
    },
  };
}

export function createLogger(opts: CreateLoggerOptions = {}): Log {
  const stream = opts.stream ?? process.stderr;
  let currentLevel = opts.level ?? "info";
  const base = createConsola({
    level: LEVEL_NUMBERS[currentLevel],
    reporters: [timestampReporter(stream)],
    formatOptions: { colors: false, date: false },
    throttle: 0,
  });

  const logger = ((message: string, ...args: unknown[]) => base.info(message, ...args)) as Log;
  logger.error = (message, ...args) => base.error(message, ...args);
  logger.warn = (message, ...args) => base.warn(message, ...args);
  logger.info = (message, ...args) => base.info(message, ...args);
  logger.debug = (message, ...args) => base.debug(message, ...args);
  logger.trace = (message, ...args) => base.trace(message, ...args);
  logger.setLevel = (level) => {
    currentLevel = level;
    base.level = LEVEL_NUMBERS[level];
  };
  logger.getLevel = () => currentLevel;
  return logger;
}

export const logger = createLogger();

export function logAt(log: Log, level: ArgusLogLevel, message: string): void {
  const method = log[level];
  if (method) method(message);
  else log(message);
}

export function logWarn(log: Log, message: string): void {
  logAt(log, "warn", message);
}

export function logError(log: Log, message: string): void {
  logAt(log, "error", message);
}

export function logDebug(log: Log | undefined, message: string): void {
  if (!log) return;
  logAt(log, "debug", message);
}

export function isLevelEnabled(log: Log, level: ArgusLogLevel): boolean {
  const current = log.getLevel?.();
  if (!current) return true;
  return LEVEL_NUMBERS[level] <= LEVEL_NUMBERS[current];
}
