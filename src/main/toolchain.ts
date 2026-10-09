/**
 * Finding the JDK and Go toolchain a Windows box has but never put on the path.
 *
 * `JAVA_HOME is not set and no 'java' command could be found in your PATH` was the single
 * most repeated recoverable failure in the recorded sessions, and it is not an inheritance
 * bug: the variable genuinely does not exist on a machine where Android Studio is the only
 * JDK, because Studio sets it for its own shells and nowhere else. The model recovered
 * every time by prefixing `$env:JAVA_HOME=…` — which means the information was available
 * all along and the round trip bought nothing.
 *
 * The rules that keep this safe:
 *
 *   - **Fill, never override.** An environment that already names JAVA_HOME or GOROOT is
 *     the user's decision and is left exactly as found.
 *   - **Only when the tool is otherwise unreachable.** If `java` already resolves on PATH,
 *     nothing here fires, so a project relying on a path-selected JDK cannot be redirected.
 *   - **Only what is verified on disk.** A candidate counts only when the actual executable
 *     is present, so this can never point a build at a directory that is not a toolchain.
 *     For Java that executable is the *compiler*: JAVA_HOME naming a JRE is a broken build,
 *     not a lesser one.
 *
 * Discovery is memoised for the life of the process: these directories do not appear or
 * move while the app is running, and this runs on every single exec_command.
 */

import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { envValue, pathEntries, prependPath, setEnvValue, type MutableEnvironment } from './env.js';

/** Filesystem questions this module asks, injectable so the tests need no real JDK. */
export interface ToolchainProbe {
  isFile(target: string): boolean;
  /** Immediate subdirectories of `target`, or `[]` when it does not exist. */
  directories(target: string): string[];
}

export const realProbe: ToolchainProbe = {
  isFile(target) {
    try {
      return existsSync(target) && statSync(target).isFile();
    } catch {
      return false;
    }
  },
  directories(target) {
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(target, entry.name));
    } catch {
      return [];
    }
  }
};

/** Where a JDK lives on Windows when nobody exported JAVA_HOME. */
function javaCandidates(env: MutableEnvironment): string[] {
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? '';

  // Exact directories first, in the order a developer would expect to win. Android Studio's
  // bundled runtime leads because on an Android machine it is the JDK every Gradle build is
  // already using; choosing anything else here would change what builds compile against.
  const exact = [
    path.join(programFiles, 'Android', 'Android Studio', 'jbr'),
    path.join(programFiles, 'Android', 'Android Studio', 'jre'),
    localAppData ? path.join(localAppData, 'Programs', 'Android Studio', 'jbr') : '',
    path.join(programFilesX86, 'Android', 'Android Studio', 'jbr')
  ].filter(Boolean);

  // Then the versioned install roots, whose child directories carry the version number.
  const scanned = [
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Microsoft'),
    path.join(programFiles, 'Amazon Corretto'),
    path.join(programFiles, 'Zulu'),
    path.join(programFiles, 'JetBrains', 'Toolbox', 'apps')
  ];

  return [...exact, ...scanned];
}

/** Where the Go toolchain lives when nobody exported GOROOT. */
function goCandidates(env: MutableEnvironment): string[] {
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? '';
  return [
    path.join(programFiles, 'Go'),
    localAppData ? path.join(localAppData, 'Programs', 'Go') : '',
    'C:\\Go'
  ].filter(Boolean);
}

/**
 * The first candidate that really holds `bin/<executable>`.
 *
 * A scanned root is descended one level, highest version first.
 */
function firstToolchain(candidates: readonly string[], executable: string, probe: ToolchainProbe): string | null {
  for (const candidate of candidates) {
    if (probe.isFile(path.join(candidate, 'bin', executable))) return candidate;
    for (const child of probe.directories(candidate).sort(byVersionDescending)) {
      if (probe.isFile(path.join(child, 'bin', executable))) return child;
    }
  }
  return null;
}

/**
 * Orders `jdk-21` above `jdk-9`, which a lexical sort does not.
 *
 * Version numbers are not text: compared as text, `9` beats `21` on the first character and
 * an installation holding both would have been handed Java 9 — a JDK old enough that current
 * Gradle refuses to run on it at all, silently, in place of the one that works. So the digit
 * runs in a name are compared as numbers and everything between them as text, which also
 * settles `jdk-21.0.5` against `jdk-21.0.12` correctly.
 *
 * Ties fall back to plain text so the order is total and the choice is reproducible. This
 * still only ever *ranks* directories that were going to be tried anyway; a name carrying no
 * version at all — `jbr`, `current` — sorts by text alone and remains reachable.
 */
function byVersionDescending(left: string, right: string): number {
  const chunks = (name: string): string[] => path.basename(name).toLowerCase().match(/\d+|\D+/g) ?? [];
  const a = chunks(left);
  const b = chunks(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    const order = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return -order;
  }
  return left < right ? 1 : left > right ? -1 : 0;
}

interface Discovery {
  javaHome: string | null;
  goRoot: string | null;
}

let cached: Discovery | null = null;
let reachability = new WeakMap<ToolchainProbe, Map<string, { java: boolean; go: boolean }>>();

/** Forgets memoised discovery. Tests only; the real filesystem does not change under us. */
export function resetToolchainCache(): void {
  cached = null;
  reachability = new WeakMap();
  claudeReachability = new WeakMap();
}

/**
 * Whether the current PATH already exposes Java/Go, memoised by probe + exact PATH value.
 *
 * `exec_command` builds a fresh child-environment object for every call, so caching on object
 * identity would buy nothing. The PATH string is the actual input to this question and is
 * process-stable in ordinary use. Keep a tiny per-probe LRU-ish map so deliberately varied
 * test/caller environments cannot grow process memory without bound.
 */
function pathReachability(env: MutableEnvironment, probe: ToolchainProbe): { java: boolean; go: boolean } {
  const key = envValue(env, 'PATH') ?? '';
  let cache = reachability.get(probe);
  if (!cache) {
    cache = new Map();
    reachability.set(probe, cache);
  }
  const held = cache.get(key);
  if (held) return held;

  let java = false;
  let go = false;
  for (const entry of pathEntries(env)) {
    if (!java && probe.isFile(path.join(entry, 'java.exe'))) java = true;
    if (!go && probe.isFile(path.join(entry, 'go.exe'))) go = true;
    if (java && go) break;
  }
  const found = { java, go };
  cache.set(key, found);
  if (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return found;
}

function discover(env: MutableEnvironment, probe: ToolchainProbe): Discovery {
  if (cached !== null) return cached;
  cached = {
    // `javac.exe`, not `java.exe`, and the difference is the whole point. A JRE ships only
    // the launcher, and `C:\Program Files\Java` holding `jdk-21` beside a leftover
    // `jre1.8.0_411` is an ordinary Oracle install — where the name ranking, which is text
    // for anything that is not a shared digit run, puts `jre` first. JAVA_HOME would then
    // have named a runtime that cannot compile, and its bin gone to the front of PATH, so
    // this module would have *broken* the Gradle build on a machine that already had a
    // working JDK 21. Probing for the compiler makes the answer a JDK by construction.
    javaHome: firstToolchain(javaCandidates(env), 'javac.exe', probe),
    goRoot: firstToolchain(goCandidates(env), 'go.exe', probe)
  };
  return cached;
}

/**
 * The Claude Code CLI that the Claude desktop app manages, when `claude` is not on PATH.
 *
 * Claude Desktop (an MSIX package on Windows) downloads its own Claude Code binary to
 * `%APPDATA%\Claude\claude-code\<version>\<build>\claude.exe` and never puts it on PATH; there is
 * no npm, winget or ~/.local/bin install on such a machine. %claude used to run `claude --version`,
 * find nothing, and fall back to driving the desktop UI (2.3.7, 2026-10-09). The newest version
 * directory that actually holds the executable wins. Not cached: the desktop app replaces the
 * directory on update while ParadigmEve keeps running.
 */
export function desktopClaudeCode(env: MutableEnvironment, probe: ToolchainProbe = realProbe): { dir: string; version: string } | null {
  const appData = envValue(env, 'APPDATA');
  if (!appData) return null;
  const versions = probe.directories(path.join(appData, 'Claude', 'claude-code'))
    .map((dir) => ({ dir, parts: /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/.exec(path.basename(dir)) }))
    .filter((entry): entry is { dir: string; parts: RegExpExecArray } => entry.parts !== null)
    .sort((left, right) => {
      for (let index = 1; index <= 3; index++) {
        const delta = Number(right.parts[index]) - Number(left.parts[index]);
        if (delta !== 0) return delta;
      }
      return 0;
    });
  for (const version of versions) {
    for (const build of probe.directories(version.dir).sort()) {
      if (probe.isFile(path.join(build, 'claude.exe'))) return { dir: build, version: path.basename(version.dir) };
    }
  }
  return null;
}

/** Memoised per probe and exact PATH, like the Java/Go reachability scan. */
let claudeReachability = new WeakMap<ToolchainProbe, Map<string, boolean>>();
function claudeOnPath(env: MutableEnvironment, probe: ToolchainProbe): boolean {
  const key = envValue(env, 'PATH') ?? '';
  let cache = claudeReachability.get(probe);
  if (!cache) {
    cache = new Map();
    claudeReachability.set(probe, cache);
  }
  const held = cache.get(key);
  if (held !== undefined) return held;
  const found = pathEntries(env).some((entry) => ['claude.exe', 'claude.cmd', 'claude.ps1'].some((name) => probe.isFile(path.join(entry, name))));
  cache.set(key, found);
  if (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return found;
}

/**
 * Adds JAVA_HOME / GOROOT to a child environment when — and only when — the tool would
 * otherwise be unreachable, and the desktop-managed Claude Code directory when `claude` is not
 * on PATH. Only this child's PATH changes; the user's global PATH is never touched. Returns what
 * it added, for the log.
 */
export function ensureDevToolchain(env: MutableEnvironment, probe: ToolchainProbe = realProbe): string[] {
  if (process.platform !== 'win32') return [];
  const added: string[] = [];

  if (!claudeOnPath(env, probe)) {
    const claude = desktopClaudeCode(env, probe);
    if (claude) {
      prependPath(env, claude.dir);
      added.push(`PATH+=Claude Code ${claude.version} (managed by Claude Desktop)`);
    }
  }

  const existingJavaHome = envValue(env, 'JAVA_HOME');
  const existingGoRoot = envValue(env, 'GOROOT');
  const reachable = existingJavaHome === undefined || existingGoRoot === undefined
    ? pathReachability(env, probe)
    : { java: true, go: true };
  const needsJava = existingJavaHome === undefined && !reachable.java;
  const needsGo = existingGoRoot === undefined && !reachable.go;
  if (!needsJava && !needsGo) return added;

  const found = discover(env, probe);

  if (needsJava && found.javaHome !== null) {
    setEnvValue(env, 'JAVA_HOME', found.javaHome);
    prependPath(env, path.join(found.javaHome, 'bin'));
    added.push(`JAVA_HOME=${found.javaHome}`);
  }
  if (needsGo && found.goRoot !== null) {
    setEnvValue(env, 'GOROOT', found.goRoot);
    prependPath(env, path.join(found.goRoot, 'bin'));
    added.push(`GOROOT=${found.goRoot}`);
  }

  return added;
}

/**
 * Whether `dir` is inside a git work tree.
 *
 * Used to tell the model which approved roots are repositories *before* it spends a call
 * finding out — `fatal: not a git repository` was one of the most repeated recoverable
 * failures, and it is pure prevention: the answer is one `stat` the model cannot make.
 *
 * Synchronous because its only caller builds the server instructions string, which is
 * assembled once per connection over a handful of roots.
 */
export function isGitRepository(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    // A worktree or submodule carries `.git` as a file rather than a directory, so the
    // question is only whether the entry exists at all.
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
