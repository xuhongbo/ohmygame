// Measures checkpoint snapshots and restores on generated workspaces.
// Usage: node --import tsx scripts/checkpoint-benchmark.ts [--keep]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CheckpointStore, checkpointDirectory } from "../src/daemon/checkpoints.js";

interface Shape {
  name: string;
  textFiles: number;
  binaryFiles: number;
  binaryBytes: number;
}

const SHAPES: Shape[] = [
  { name: "small (200 text files)", textFiles: 200, binaryFiles: 0, binaryBytes: 0 },
  { name: "assets (1,700 text + 300 x 1 MB binary)", textFiles: 1_700, binaryFiles: 300, binaryBytes: 1024 * 1024 },
  { name: "large assets (200 text + 12 x 25 MB binary)", textFiles: 200, binaryFiles: 12, binaryBytes: 25 * 1024 * 1024 },
];
const keep = process.argv.includes("--keep");

async function generate(root: string, shape: Shape): Promise<{ workspacePath: string; storagePath: string }> {
  const workspacePath = path.join(root, "workspace");
  for (let index = 0; index < shape.textFiles; index += 1) {
    const directory = path.join(workspacePath, "src", `module-${index % 40}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `file-${index}.ts`), `export const value${index} = ${JSON.stringify("x".repeat(1_000 + (index % 7) * 1_000))};\n`);
  }
  for (let index = 0; index < shape.binaryFiles; index += 1) {
    const directory = path.join(workspacePath, "assets", `pack-${index % 10}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `asset-${index}.bin`), randomBytes(shape.binaryBytes));
  }
  // Excluded content: it must cost nothing and must survive a restore.
  await mkdir(path.join(workspacePath, "node_modules", "dependency"), { recursive: true });
  for (let index = 0; index < 500; index += 1) await writeFile(path.join(workspacePath, "node_modules", "dependency", `${index}.js`), "module.exports = 1;\n");
  await mkdir(path.join(workspacePath, ".data"), { recursive: true });
  await writeFile(path.join(workspacePath, ".data", "assets.json"), "{}\n");
  return { workspacePath, storagePath: root };
}

async function timed<T>(operation: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await operation();
  return { ms: Math.round(performance.now() - started), value };
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(target) : (await stat(target)).size;
  }
  return total;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const rows: Record<string, string | number>[] = [];
for (const shape of SHAPES) {
  {
    const root = await mkdtemp(path.join(tmpdir(), "ohmygame-checkpoint-benchmark-"));
    try {
      const project = await generate(root, shape);
      const store = new CheckpointStore();
      const first = await timed(() => store.snapshot(project));
      const unchanged = await timed(() => store.snapshot(project));
      if (unchanged.value !== first.value) throw new Error("A snapshot of an unchanged workspace must reuse the commit");

      const edited = [0, 1, 2, 3].map((index) => path.join(project.workspacePath, "src", `module-${index}`, `file-${index}.ts`));
      const originals = await Promise.all(edited.map((file) => readFile(file, "utf8")));
      for (const file of edited) await writeFile(file, `// edited\n${await readFile(file, "utf8")}`);
      await writeFile(path.join(project.workspacePath, "src", "added.ts"), "export const added = true;\n");
      const binary = shape.binaryFiles ? path.join(project.workspacePath, "assets", "pack-0", "asset-0.bin") : undefined;
      if (binary) await writeFile(binary, randomBytes(shape.binaryBytes));
      const changed = await timed(() => store.snapshot(project));

      const restored = await timed(() => store.restore(project, first.value));
      const back = await Promise.all(edited.map((file) => readFile(file, "utf8")));
      if (back.some((text, index) => text !== originals[index])) throw new Error("Restore did not bring the edited files back");
      if (await stat(path.join(project.workspacePath, "src", "added.ts")).then(() => true, () => false)) throw new Error("Restore kept a file the snapshot does not have");
      if ((await readdir(path.join(project.workspacePath, "node_modules", "dependency"))).length !== 500) throw new Error("Restore touched excluded files");

      const gitdir = checkpointDirectory(project);
      let fsck = "skipped";
      try {
        execFileSync("git", ["--git-dir", gitdir, "fsck", "--strict", "--no-dangling"], { stdio: "pipe" });
        fsck = "ok";
      } catch (cause) {
        fsck = (cause as { code?: string }).code === "ENOENT" ? "git not installed" : `FAILED: ${String((cause as { stderr?: Buffer }).stderr)}`;
      }
      rows.push({
        workspace: shape.name,
        "first snapshot (ms)": first.ms,
        "unchanged (ms)": unchanged.ms,
        "after small edit (ms)": changed.ms,
        "restore (ms)": restored.ms,
        "paths restored": restored.value.changed.length,
        "workspace size": megabytes(await directorySize(project.workspacePath) ),
        "store size": megabytes(await directorySize(gitdir)),
        "git fsck": fsck,
      });
    } finally {
      if (keep) console.log(`kept ${root}`);
      else await rm(root, { recursive: true, force: true });
    }
  }
}
console.log(`runtime: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`}`);
console.table(rows);
