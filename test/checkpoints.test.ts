import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore, checkpointDirectory } from "../src/daemon/checkpoints.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A project whose workspace holds these files, by path and content. */
async function project(files: Record<string, string>) {
  const storagePath = await mkdtemp(path.join(tmpdir(), "ohmygame-checkpoints-"));
  roots.push(storagePath);
  const workspacePath = path.join(storagePath, "workspace");
  await mkdir(workspacePath);
  await write(workspacePath, files);
  return { workspacePath, storagePath };
}

async function write(workspacePath: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true });
    await writeFile(path.join(workspacePath, file), content);
  }
}

/** Every file under a folder, by path and content. */
async function contents(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await contents(directory, entryPath));
    else result[entryPath] = await readFile(path.join(directory, entryPath), "utf8");
  }
  return result;
}

describe("workspace checkpoints", () => {
  it("puts changed, added and removed files back and reports them", async () => {
    const files = { "index.html": "<main></main>", "src/game.ts": "export const speed = 1;\n", "src/levels/one.json": "{}", "assets/hero.png": "hero" };
    const game = await project(files);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    await write(game.workspacePath, { "src/game.ts": "export const speed = 9;\n", "src/enemies/boss.ts": "export {};\n" });
    await rm(path.join(game.workspacePath, "src/levels"), { recursive: true });
    await rm(path.join(game.workspacePath, "assets/hero.png"));

    const restored = await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual(files);
    expect(restored.changed.sort()).toEqual(["assets/hero.png", "src/enemies/boss.ts", "src/game.ts", "src/levels/one.json"]);
    // The folder that held only the added file is gone with it.
    expect((await readdir(path.join(game.workspacePath, "src"))).sort()).toEqual(["game.ts", "levels"]);
  });

  it("reuses the commit when nothing changed, also without its file cache", async () => {
    const game = await project({ "index.html": "<main></main>", "src/game.ts": "export {};\n" });
    const store = new CheckpointStore();
    const first = await store.snapshot(game);
    expect(await store.snapshot(game)).toBe(first);
    await rm(path.join(checkpointDirectory(game), "ohmygame-stat-cache.json"));
    expect(await store.snapshot(game)).toBe(first);
    await writeFile(path.join(checkpointDirectory(game), "ohmygame-stat-cache.json"), "not json");
    expect(await new CheckpointStore().snapshot(game)).toBe(first);

    await write(game.workspacePath, { "src/game.ts": "export const changed = true;\n" });
    expect(await store.snapshot(game)).not.toBe(first);
  });

  it("keeps its store outside the workspace and writes nothing into the workspace", async () => {
    const files = { "index.html": "<main></main>" };
    const game = await project(files);
    await new CheckpointStore().snapshot(game);
    expect(await contents(game.workspacePath)).toEqual(files);
    expect(checkpointDirectory(game)).toBe(path.join(game.storagePath, "checkpoints"));
    expect((await readdir(game.storagePath)).sort()).toEqual(["checkpoints", "workspace"]);
  });

  it("leaves dependencies, version control, build output and caches out and never touches them", async () => {
    const kept = {
      "node_modules/phaser/index.js": "module.exports = 1;\n",
      "packages/ui/node_modules/react/index.js": "module.exports = 2;\n",
      ".git/HEAD": "ref: refs/heads/main\n",
      "dist/index.js": "built",
      "build/index.js": "built",
      "out/index.js": "built",
      ".ohmygame/thumbnails/scene.png": "thumbnail",
      ".ohmygame-install-pending": "",
      ".data/agent-attachments/notes.txt": "attachment",
    };
    const game = await project({ ...kept, "src/game.ts": "one", "src/dist/tiles.json": "one", ".data/assets.json": "{\"one\":true}" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    const edited = Object.fromEntries(Object.keys(kept).map((file) => [file, "changed after the snapshot"]));
    await write(game.workspacePath, { ...edited, "node_modules/added/index.js": "new", "src/game.ts": "two", "src/dist/tiles.json": "two", ".data/assets.json": "{}" });

    const restored = await store.restore(game, before);
    expect(restored.changed.sort()).toEqual([".data/assets.json", "src/dist/tiles.json", "src/game.ts"]);
    expect(await contents(game.workspacePath)).toEqual({
      ...edited,
      "node_modules/added/index.js": "new",
      "src/game.ts": "one",
      "src/dist/tiles.json": "one",
      ".data/assets.json": "{\"one\":true}",
    });
  });

  it("ignores the workspace's own .gitignore", async () => {
    const game = await project({ ".gitignore": "*.png\nsecret.txt\n", "assets/hero.png": "hero", "secret.txt": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "assets/hero.png": "changed", "secret.txt": "two" });
    await store.restore(game, before);
    expect(await contents(game.workspacePath)).toMatchObject({ "assets/hero.png": "hero", "secret.txt": "one" });
  });

  it("restores a file where a folder was and a folder where a file was", async () => {
    const files = { "levels": "all levels in one file", "enemies/boss.ts": "boss", "enemies/minion.ts": "minion" };
    const game = await project(files);
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    await rm(path.join(game.workspacePath, "levels"));
    await rm(path.join(game.workspacePath, "enemies"), { recursive: true });
    await write(game.workspacePath, { "levels/one.json": "{}", "levels/two.json": "{}", "enemies": "all enemies in one file" });

    await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual(files);
  });

  it.skipIf(process.platform === "win32")("keeps executable files and symbolic links as they were", async () => {
    const game = await project({ "tools/build.sh": "#!/bin/sh\n", "src/game.ts": "export {};\n" });
    await chmod(path.join(game.workspacePath, "tools/build.sh"), 0o755);
    await symlink("src/game.ts", path.join(game.workspacePath, "entry.ts"));
    const store = new CheckpointStore();
    const before = await store.snapshot(game);

    await chmod(path.join(game.workspacePath, "tools/build.sh"), 0o644);
    await rm(path.join(game.workspacePath, "entry.ts"));
    await writeFile(path.join(game.workspacePath, "entry.ts"), "no longer a link");

    await store.restore(game, before);
    expect((await lstat(path.join(game.workspacePath, "tools/build.sh"))).mode & 0o111).not.toBe(0);
    expect(await readlink(path.join(game.workspacePath, "entry.ts"))).toBe("src/game.ts");
  });

  it("can take a restore back", async () => {
    const game = await project({ "src/game.ts": "one" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two", "src/added.ts": "added" });

    const restored = await store.restore(game, before);
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "one" });
    await store.restore(game, restored.undo);
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "two", "src/added.ts": "added" });
  });

  it("changes nothing when asked for a snapshot it does not have", async () => {
    const files = { "src/game.ts": "one" };
    const game = await project(files);
    const store = new CheckpointStore();
    await store.snapshot(game);
    await write(game.workspacePath, { "src/game.ts": "two" });
    await expect(store.restore(game, "0".repeat(40))).rejects.toThrow();
    expect(await contents(game.workspacePath)).toEqual({ "src/game.ts": "two" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("puts files back when a restore fails part way", async () => {
    const game = await project({ "a/one.ts": "one", "locked/two.ts": "two" });
    const store = new CheckpointStore();
    const before = await store.snapshot(game);
    const after = { "a/one.ts": "changed one", "locked/two.ts": "changed two" };
    await write(game.workspacePath, after);
    // The restore can rewrite a/one.ts but cannot replace locked/two.ts.
    await chmod(path.join(game.workspacePath, "locked"), 0o555);
    try {
      await expect(store.restore(game, before)).rejects.toThrow();
    } finally {
      await chmod(path.join(game.workspacePath, "locked"), 0o755);
    }
    expect(await contents(game.workspacePath)).toEqual(after);
  });

  it("runs snapshots and restores of one project one at a time", async () => {
    const game = await project(Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/file-${index}.ts`, `export const value = ${index};\n`])));
    const store = new CheckpointStore();
    const commits = await Promise.all(Array.from({ length: 6 }, () => store.snapshot(game)));
    expect(new Set(commits).size).toBe(1);

    await write(game.workspacePath, { "src/file-0.ts": "changed" });
    const [restored, snapshot] = await Promise.all([store.restore(game, commits[0]!), store.snapshot(game)]);
    expect(restored.changed).toEqual(["src/file-0.ts"]);
    // The snapshot queued behind the restore sees the restored workspace.
    expect(await store.restore(game, snapshot)).toMatchObject({ changed: [] });
  });
});
