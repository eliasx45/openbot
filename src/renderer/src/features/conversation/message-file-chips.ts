import { FILE_CHIP_CHECK_LIMIT, type FileChipTarget } from "@openbot/contracts/ipc";
import type { ConversationRuntime } from "./conversation-runtime";

/** The answers kept for the open chat. A message names few files, so this covers many messages. */
const CACHE_LIMIT = 2_000;

interface Pending {
  file: FileChipTarget;
  resolve: (resolves: boolean) => void;
}

/**
 * Asks the host whether each file that a code span names opens, so only those show as chips. The
 * names that render in one task go to the host in one request for each agent. Each message keeps
 * its own answer: a newer message that names the same path asks again, because the file can be new.
 * A failed check answers false, so the name stays plain code.
 */
export function createMessageFileChips(agent: Pick<ConversationRuntime["agent"], "checkFileChips">) {
  // Insertion order is the use order: the first entry is the least recently used.
  const cache = new Map<string, Promise<boolean>>();
  const batches = new Map<string, { serverId: string; agentId: string | undefined; files: Pending[] }>();

  function flush() {
    const queued = [...batches.values()];
    batches.clear();
    for (const batch of queued) {
      for (let start = 0; start < batch.files.length; start += FILE_CHIP_CHECK_LIMIT) {
        const part = batch.files.slice(start, start + FILE_CHIP_CHECK_LIMIT);
        const input = {
          ...(batch.agentId === undefined ? {} : { agentId: batch.agentId }),
          files: part.map((pending) => pending.file),
        };
        const answer = agent.checkFileChips?.(input, batch.serverId) ?? Promise.resolve(part.map(() => true));
        void answer.then(
          (answers) => {
            for (const [index, pending] of part.entries()) pending.resolve(answers[index] === true);
          },
          () => {
            for (const pending of part) pending.resolve(false);
          },
        );
      }
    }
  }

  return (
    file: FileChipTarget,
    scope: { serverId: string; messageId: string; agentId: string | undefined },
  ): Promise<boolean> => {
    const agentId = file.kind === "workspace" ? scope.agentId : undefined;
    const key = `${scope.serverId}:${scope.messageId}:${file.kind}:${agentId ?? ""}:${file.path}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const job = new Promise<boolean>((resolve) => {
      const batchKey = `${scope.serverId}:${agentId ?? ""}`;
      const batch = batches.get(batchKey) ?? { serverId: scope.serverId, agentId, files: [] };
      if (batches.size === 0) queueMicrotask(flush);
      batches.set(batchKey, batch);
      batch.files.push({ file, resolve });
    });
    cache.set(key, job);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return job;
  };
}
