import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { ConversationDetail, ThreadItem } from "../src/shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Step = { write: Record<string, string> } | { say: string; delayMs?: number };

/** A model that answers each request with the next scripted step: files to write with the `write` tool, or a final reply. */
async function scriptedModel(steps: Step[]) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* The request is not inspected. */ }
    const step = steps.shift() ?? { say: "Nothing left to do." };
    if ("delayMs" in step && step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    const delta = "write" in step
      ? {
        role: "assistant",
        tool_calls: Object.entries(step.write).map(([file, content], index) => ({
          index,
          id: `write-${calls++}`,
          type: "function",
          function: { name: "write", arguments: JSON.stringify({ path: file, content }) },
        })),
      }
      : { role: "assistant", content: step.say };
    const chunk = (choice: object) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk({ delta, finish_reason: null }));
    response.write(chunk({ delta: {}, finish_reason: "write" in step ? "tool_calls" : "stop" }));
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

/** A daemon with a project, a conversation and the scripted model selected. */
async function studio(steps: Step[], type = "web-game") {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-agent-checkpoints-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const baseUrl = await scriptedModel(steps);
  const runtime = await ModelRuntime.create({
    authPath: path.join(directory, "auth.json"),
    modelsPath: path.join(directory, "models.json"),
    modelsStorePath: path.join(directory, "catalog.json"),
    allowModelNetwork: false,
  });
  const start = () => {
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    cleanup.push(() => app.close());
    return app;
  };
  const app = start();
  const provider = await app.inject({
    method: "POST",
    url: "/settings/models/providers/custom",
    payload: {
      name: "Fixture model", baseUrl, api: "openai-completions", authentication: "api_key", apiKey: "fixture",
      models: [{ id: "fixture", name: "Fixture", api: "openai-completions", contextWindow: 32_000, maxTokens: 4_000, reasoning: false, supportsImages: false }],
    },
  });
  expect(provider.statusCode, provider.body).toBe(201);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Checkpoints", type } })).json();
  const conversation = (await app.inject({ method: "POST", url: `/projects/${project.id}/conversations`, payload: { model: { provider: provider.json().id, id: "fixture" } } })).json();
  const base = `/projects/${project.id}/conversations/${conversation.id}`;
  type App = ReturnType<typeof createApp>;
  const detail = async (from: App = app) => (await from.inject({ method: "GET", url: base })).json() as ConversationDetail;
  const userMessages = async (from: App = app) => (await detail(from)).turns.flatMap((turn) => turn.items).filter((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
  const send = async (prompt: string) => {
    const response = await app.inject({ method: "POST", url: `${base}/turns`, payload: { prompt } });
    expect(response.statusCode, response.body).toBe(202);
    return response.json() as { turnId: string; queued: boolean };
  };
  const idle = (turns: number) => vi.waitFor(async () => {
    const current = await detail();
    expect(current.agent, JSON.stringify(current.agent)).toMatchObject({ status: "idle" });
    expect(current.turns.filter((turn) => turn.status === "completed")).toHaveLength(turns);
  }, { timeout: 15_000 });
  const file = (name: string) => readFile(path.join(project.workspacePath, name), "utf8");
  const missing = (name: string) => stat(path.join(project.workspacePath, name)).then(() => false, () => true);
  const restore = (checkpointId: string, from: App = app) => from.inject({ method: "POST", url: `${base}/checkpoints/${checkpointId}/restore` });
  return { app, start, project, base, detail, userMessages, send, idle, file, missing, restore };
}

describe("Agent checkpoints", () => {
  it("restores the workspace and the conversation to before a message, and the result survives a restart", async () => {
    const { app, start, project, userMessages, send, idle, file, missing, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second", "extra/added.txt": "added" } },
      { say: "Changed the notes." },
    ]);
    await writeFile(path.join(project.workspacePath, "player.txt"), "written by the player before any turn");

    await send("Write the notes");
    await idle(1);
    expect(await file("notes.txt")).toBe("first");
    await send("Change the notes");
    await idle(2);
    expect(await file("notes.txt")).toBe("second");
    expect(await file("extra/added.txt")).toBe("added");

    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual(["Write the notes", "Change the notes"]);
    expect(messages.every((message) => typeof message.checkpointId === "string")).toBe(true);
    expect(messages[0]!.checkpointId).not.toBe(messages[1]!.checkpointId);

    // Back to before the second message: its changes are gone, the first turn's stay.
    const second = await restore(messages[1]!.checkpointId!);
    expect(second.statusCode, second.body).toBe(204);
    expect(await file("notes.txt")).toBe("first");
    expect(await missing("extra/added.txt")).toBe(true);
    expect(await missing("extra")).toBe(true);
    expect((await userMessages()).map((message) => message.text)).toEqual(["Write the notes"]);
    // The message that checkpoint belonged to is gone, so the checkpoint is too.
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(404);

    await app.close();
    const restarted = start();
    expect((await userMessages(restarted)).map((message) => message.text)).toEqual(["Write the notes"]);

    // Back to before the first message: only what the player had is left.
    const first = await restore(messages[0]!.checkpointId!, restarted);
    expect(first.statusCode, first.body).toBe(204);
    expect(await missing("notes.txt")).toBe(true);
    expect(await file("player.txt")).toBe("written by the player before any turn");
    expect(await userMessages(restarted)).toEqual([]);
  });

  it("continues the conversation from the restored point", async () => {
    const { userMessages, send, idle, file, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second" } },
      { say: "Changed the notes." },
      { write: { "notes.txt": "third" } },
      { say: "Changed the notes another way." },
    ]);
    await send("Write the notes");
    await idle(1);
    await send("Change the notes");
    await idle(2);
    const [, second] = await userMessages();
    expect((await restore(second!.checkpointId!)).statusCode).toBe(204);

    await send("Change the notes another way");
    await idle(2);
    expect(await file("notes.txt")).toBe("third");
    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual(["Write the notes", "Change the notes another way"]);
    // The new message has its own checkpoint, taken after the restore.
    expect(messages[1]!.checkpointId).not.toBe(second!.checkpointId);
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(204);
    expect(await file("notes.txt")).toBe("first");
  });

  it("takes a checkpoint for a message that was queued behind a running turn", async () => {
    const { userMessages, send, idle, file, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes.", delayMs: 400 },
      { write: { "notes.txt": "second" } },
      { say: "Changed the notes." },
    ]);
    await send("Write the notes");
    await vi.waitFor(async () => expect(await file("notes.txt")).toBe("first"), { timeout: 15_000 });
    expect((await send("Change the notes")).queued).toBe(true);
    await idle(2);
    expect(await file("notes.txt")).toBe("second");

    const messages = await userMessages();
    expect(messages.map((message) => message.text)).toEqual(["Write the notes", "Change the notes"]);
    expect((await restore(messages[1]!.checkpointId!)).statusCode).toBe(204);
    expect(await file("notes.txt")).toBe("first");
  });

  it("refuses to restore while the Agent is working and for checkpoints it does not have", async () => {
    const { base, app, userMessages, send, idle, file, restore } = await studio([
      { write: { "notes.txt": "first" } },
      { say: "Wrote the notes." },
      { write: { "notes.txt": "second" } },
      { say: "Changed the notes.", delayMs: 600 },
    ]);
    await send("Write the notes");
    await idle(1);
    const [first] = await userMessages();

    await send("Change the notes");
    await vi.waitFor(async () => expect(await file("notes.txt")).toBe("second"), { timeout: 15_000 });
    const busy = await restore(first!.checkpointId!);
    expect(busy.statusCode, busy.body).toBe(409);
    expect(await file("notes.txt")).toBe("second");
    await idle(2);

    expect((await restore("missing")).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${base.replace(/[^/]+$/, "missing")}/checkpoints/${first!.checkpointId}/restore` })).statusCode).toBe(404);
    expect(await file("notes.txt")).toBe("second");
  });

  it("takes no checkpoints in a Canvas project", async () => {
    const { userMessages, send, idle } = await studio([{ say: "Nothing to change." }], "asset-canvas");
    await send("Hello");
    await idle(1);
    const [message] = await userMessages();
    expect(message).toMatchObject({ text: "Hello" });
    expect(message!.checkpointId).toBeUndefined();
  });
});
