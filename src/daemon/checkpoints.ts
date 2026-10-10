import * as fs from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import git, { type TreeEntry } from "isomorphic-git";
import type { ProjectState } from "../shared/contracts.js";

type CheckpointProject = Pick<ProjectState, "workspacePath" | "storagePath">;

export interface CheckpointRestoreResult {
  /** The workspace as it was just before the restore, so the restore can be taken back. */
  undo: string;
  /** Workspace paths the restore wrote or removed. */
  changed: string[];
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: string;
  oid: string;
}

type StatCache = Record<string, CachedFile>;

const HEAD_REF = "refs/heads/checkpoints";
const STAT_CACHE_FILE = "ohmygame-stat-cache.json";
const AUTHOR = { name: "OhMyGame", email: "checkpoints@ohmygame.local" };
const FILE_CONCURRENCY = 16;
// Dependencies, version control, and caches the app rebuilds are never part of a checkpoint and are never touched by a restore.
const EXCLUDED_ANYWHERE = new Set(["node_modules", ".git"]);
const EXCLUDED_AT_ROOT = new Set(["dist", "build", "out", ".ohmygame", ".ohmygame-install-pending", ".data/agent-attachments"]);

/** The git directory that holds a project's checkpoints. It is outside the workspace and is removed with the project. */
export function checkpointDirectory(project: CheckpointProject): string {
  return path.join(project.storagePath ?? path.dirname(project.workspacePath), "checkpoints");
}

function excluded(relativePath: string): boolean {
  if (EXCLUDED_AT_ROOT.has(relativePath)) return true;
  return EXCLUDED_ANYWHERE.has(path.posix.basename(relativePath));
}

/**
 * Snapshots of a project's workspace in a git object store, taken before the
 * Agent changes anything so the workspace can be put back. The store never
 * uses the workspace's own `.git` or `.gitignore` and writes nothing into the
 * workspace except when restoring.
 */
export class CheckpointStore {
  readonly #queues = new Map<string, Promise<unknown>>();

  /** Records the workspace as it is now and returns the commit that holds it. */
  snapshot(project: CheckpointProject): Promise<string> {
    return this.#serialize(project, () => this.#snapshot(project));
  }

  /** Puts the workspace back to a snapshot. Only paths that differ are written or removed. */
  restore(project: CheckpointProject, commit: string): Promise<CheckpointRestoreResult> {
    return this.#serialize(project, async () => {
      const gitdir = checkpointDirectory(project);
      const undo = await this.#snapshot(project);
      const [current, target] = await Promise.all([this.#treeOf(gitdir, undo), this.#treeOf(gitdir, commit)]);
      const changes: Change[] = [];
      await this.#diff(gitdir, current, target, "", changes);
      const cache = await readStatCache(gitdir);
      const workspace = project.workspacePath;
      // Removals go first so a file can take the place of a folder and the other way round.
      for (const change of changes) {
        if (change.to) continue;
        await rm(path.join(workspace, change.path), { force: true });
        delete cache[change.path];
        await removeEmptyDirectories(workspace, path.posix.dirname(change.path));
      }
      await mapLimit(changes.filter((change) => change.to), FILE_CONCURRENCY, async (change) => {
        const { oid, mode } = change.to!;
        const target = path.join(workspace, change.path);
        await mkdir(path.dirname(target), { recursive: true });
        const content = (await git.readBlob({ fs, gitdir, oid })).blob;
        await rm(target, { force: true });
        if (mode === "120000") await symlink(Buffer.from(content).toString("utf8"), target);
        else {
          await writeFile(target, content);
          await chmod(target, mode === "100755" ? 0o755 : 0o644);
        }
        const stats = await lstat(target);
        cache[change.path] = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, mode, oid };
      });
      await writeStatCache(gitdir, cache);
      return { undo, changed: changes.map((change) => change.path) };
    });
  }

  async #snapshot(project: CheckpointProject): Promise<string> {
    const gitdir = checkpointDirectory(project);
    await this.#initialize(gitdir);
    const previous = await readStatCache(gitdir);
    const next: StatCache = {};
    const tree = await this.#writeDirectory(gitdir, project.workspacePath, "", previous, next) ?? await git.writeTree({ fs, gitdir, tree: [] });
    await writeStatCache(gitdir, next);
    const parent = await git.resolveRef({ fs, gitdir, ref: HEAD_REF }).catch(() => undefined);
    if (parent && await this.#treeOf(gitdir, parent) === tree) return parent;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = { ...AUTHOR, timestamp, timezoneOffset: 0 };
    const commit = await git.writeCommit({
      fs,
      gitdir,
      commit: { message: "checkpoint\n", tree, parent: parent ? [parent] : [], author: signature, committer: signature },
    });
    await git.writeRef({ fs, gitdir, ref: HEAD_REF, value: commit, force: true });
    return commit;
  }

  /** Writes one folder as a tree and returns its id, or undefined when nothing in it is kept. */
  async #writeDirectory(gitdir: string, workspace: string, relative: string, previous: StatCache, next: StatCache): Promise<string | undefined> {
    const names = await readdir(path.join(workspace, relative), { withFileTypes: true });
    const entries = (await mapLimit(names, FILE_CONCURRENCY, async (entry): Promise<TreeEntry | undefined> => {
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded(entryPath)) return undefined;
      if (entry.isDirectory()) {
        const oid = await this.#writeDirectory(gitdir, workspace, entryPath, previous, next);
        return oid ? { mode: "040000", path: entry.name, oid, type: "tree" } : undefined;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) return undefined;
      const absolute = path.join(workspace, entryPath);
      const stats = await lstat(absolute);
      const mode = entry.isSymbolicLink() ? "120000" : stats.mode & 0o111 ? "100755" : "100644";
      const cached = previous[entryPath];
      const unchanged = cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.mode === mode;
      const oid = unchanged
        ? cached.oid
        : await git.writeBlob({ fs, gitdir, blob: entry.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute) });
      next[entryPath] = { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, mode, oid };
      return { mode, path: entry.name, oid, type: "blob" };
    })).filter((entry): entry is TreeEntry => entry !== undefined);
    return entries.length ? await git.writeTree({ fs, gitdir, tree: entries }) : undefined;
  }

  async #treeOf(gitdir: string, commit: string): Promise<string> {
    return (await git.readCommit({ fs, gitdir, oid: commit })).commit.tree;
  }

  /** Collects the paths where two trees differ. Subtrees with the same id are skipped whole. */
  async #diff(gitdir: string, from: string | undefined, to: string | undefined, prefix: string, changes: Change[]): Promise<void> {
    if (from === to) return;
    const [before, after] = await Promise.all([this.#entries(gitdir, from), this.#entries(gitdir, to)]);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const left = before.get(name);
      const right = after.get(name);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (left?.oid === right?.oid && left?.mode === right?.mode) continue;
      const leftTree = left?.type === "tree" ? left.oid : undefined;
      const rightTree = right?.type === "tree" ? right.oid : undefined;
      if (leftTree || rightTree) await this.#diff(gitdir, leftTree, rightTree, entryPath, changes);
      if (left?.type === "blob" && right?.type !== "blob") changes.push({ path: entryPath });
      if (right?.type === "blob") changes.push({ path: entryPath, to: { oid: right.oid, mode: right.mode } });
    }
  }

  async #entries(gitdir: string, tree: string | undefined): Promise<Map<string, TreeEntry>> {
    if (!tree) return new Map();
    return new Map((await git.readTree({ fs, gitdir, oid: tree })).tree.map((entry) => [entry.path, entry]));
  }

  async #initialize(gitdir: string): Promise<void> {
    if (await exists(path.join(gitdir, "HEAD"))) return;
    await mkdir(gitdir, { recursive: true });
    await git.init({ fs, gitdir, bare: true, defaultBranch: "checkpoints" });
  }

  /** Snapshots and restores of one project run one at a time: two conversations may work in it at once. */
  #serialize<T>(project: CheckpointProject, operation: () => Promise<T>): Promise<T> {
    const key = checkpointDirectory(project);
    const result = (this.#queues.get(key) ?? Promise.resolve()).then(operation, operation);
    const settled = result.catch(() => {});
    this.#queues.set(key, settled);
    void settled.then(() => { if (this.#queues.get(key) === settled) this.#queues.delete(key); });
    return result;
  }
}

interface Change {
  path: string;
  /** The blob to write; absent when the path is removed. */
  to?: { oid: string; mode: string };
}

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false);
}

async function readStatCache(gitdir: string): Promise<StatCache> {
  try {
    return JSON.parse(await readFile(path.join(gitdir, STAT_CACHE_FILE), "utf8")) as StatCache;
  } catch {
    // Without the cache every file is read again, which is only slower.
    return {};
  }
}

async function writeStatCache(gitdir: string, cache: StatCache): Promise<void> {
  const target = path.join(gitdir, STAT_CACHE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(cache));
  await rename(temporary, target);
}

/** Removes folders a restore emptied, from the given one up to the workspace root. */
async function removeEmptyDirectories(workspace: string, relative: string): Promise<void> {
  for (let current = relative; current && current !== "."; current = path.posix.dirname(current)) {
    try {
      await rmdir(path.join(workspace, current));
    } catch {
      return;
    }
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index]!);
    }
  }));
  return results;
}
