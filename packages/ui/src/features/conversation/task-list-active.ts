/**
 * Fork: the task that a task list's header names: the `current` task while it is active, else the
 * last active task. An agent can keep more than one task active; the first one is often an older
 * task it left open, so the header showed step 1 while the agent worked on a later one (Elias,
 * 8 Nov 2026: "stay running on step 1 visually even though it's on a later step").
 */
export function activeTask<Item extends { id: string; state: string }>(
  items: readonly Item[],
  current: string | undefined,
): Item | undefined {
  return (
    items.find((item) => item.id === current && item.state === "active") ??
    items.findLast((item) => item.state === "active")
  );
}
