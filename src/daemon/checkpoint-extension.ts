import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Session entry that records the workspace snapshot taken before the user message that follows it. */
export const CHECKPOINT_ENTRY = "ohmygame-checkpoint";

/** Session entry written after the workspace and the conversation were put back to a checkpoint. */
export const CHECKPOINT_RESTORED_ENTRY = "ohmygame-checkpoint-restored";

export interface StoredCheckpoint {
  version: 1;
  /** The snapshot in the project's checkpoint store. */
  commit: string;
}

export function parseStoredCheckpoint(value: unknown): StoredCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<StoredCheckpoint>;
  return data.version === 1 && typeof data.commit === "string" && /^[0-9a-f]{40}$/.test(data.commit)
    ? { version: 1, commit: data.commit }
    : undefined;
}

/**
 * Pi extension that snapshots the workspace before each user message is
 * acted on. A user message ends before Pi stores it and before any tool
 * runs, whether it was sent, queued, or steered into a running turn, and Pi
 * waits for this handler. A failed snapshot leaves the message without a
 * checkpoint and does not stop the turn.
 */
export function checkpointExtension(snapshot: () => Promise<string>): ExtensionFactory {
  return (pi) => {
    pi.on("message_end", async (event) => {
      if (event.message.role !== "user") return;
      const checkpoint: StoredCheckpoint = { version: 1, commit: await snapshot() };
      pi.appendEntry(CHECKPOINT_ENTRY, checkpoint);
    });
  };
}
