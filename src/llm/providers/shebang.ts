import {
  closeSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

const SHEBANG_READ_BYTES = 512;

export type CanExecute = (path: string) => boolean;
export type Realpath = (path: string) => string;
export type ReadFilePrefix = (path: string, bytes: number) => string | undefined;

export interface ShebangSandboxResolutionOptions {
  paths: string[];
  env?: NodeJS.ProcessEnv;
  canExecute: CanExecute;
  realpath: Realpath;
  readFilePrefix?: ReadFilePrefix;
}

export interface ShebangSandboxResolution {
  processExecPaths: string[];
  launchFile?: string;
  launchArgsPrefix?: string[];
}

function uniqueSorted(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => !!path?.trim()))].sort();
}

function uniqueInOrder(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => !!path?.trim()))];
}

export function defaultReadFilePrefix(path: string, bytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(bytes);
    const length = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function tryRealpath(path: string, realpath: Realpath): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

function splitShebangArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

function executableAliases(path: string, realpath: Realpath): string[] {
  if (!isAbsolute(path)) return [];
  return [...new Set([path, tryRealpath(path, realpath)])];
}

function resolveExecutableOnPath(
  command: string | undefined,
  env: NodeJS.ProcessEnv,
  canExecute: CanExecute,
  realpath: Realpath,
  extraSearchDirs: string[] = [],
): string[] {
  if (!command) return [];
  if (command.includes("/")) return executableAliases(command, realpath);

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  for (const dir of uniqueInOrder([...pathValue.split(delimiter), ...extraSearchDirs])) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (canExecute(candidate)) return executableAliases(candidate, realpath);
  }
  return [];
}

function envShebangCommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-S") return args[i + 1];
    if (arg.startsWith("-S") && arg.length > 2)
      return splitShebangArgs(arg.slice(2))[0];
    if (arg === "--") return args[i + 1];
    if (arg === "-u" || arg === "--unset" || arg === "-P" || arg === "--path") {
      i++;
      continue;
    }
    if (arg.startsWith("--unset=") || arg.startsWith("--path=")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)) continue;
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

export function resolveShebangSandbox({
  paths,
  env = process.env,
  canExecute,
  realpath,
  readFilePrefix = defaultReadFilePrefix,
}: ShebangSandboxResolutionOptions): ShebangSandboxResolution {
  const processExecPaths: string[] = [];
  let launchFile: string | undefined;
  let launchArgsPrefix: string[] | undefined;

  for (const path of uniqueInOrder(paths)) {
    const prefix = readFilePrefix(path, SHEBANG_READ_BYTES);
    const line = prefix?.split(/\r?\n/, 1)[0]?.trim();
    if (!line?.startsWith("#!")) continue;

    const [interpreter, ...args] = splitShebangArgs(line.slice(2));
    const interpreterPaths = resolveExecutableOnPath(
      interpreter,
      env,
      canExecute,
      realpath,
    );
    processExecPaths.push(...interpreterPaths);

    const realInterpreter = tryRealpath(interpreterPaths[0] ?? "", realpath);
    if (basename(realInterpreter) !== "env") continue;
    const envCommandPaths = resolveExecutableOnPath(
      envShebangCommand(args),
      env,
      canExecute,
      realpath,
      [dirname(path)],
    );
    processExecPaths.push(...envCommandPaths);
    if (!launchFile && basename(envCommandPaths[0] ?? "") === "node") {
      launchFile = envCommandPaths[0];
      launchArgsPrefix = [path];
    }
  }
  return {
    processExecPaths: uniqueSorted(processExecPaths),
    ...(launchFile ? { launchFile, launchArgsPrefix } : {}),
  };
}
