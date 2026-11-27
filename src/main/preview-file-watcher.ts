import { watch } from "node:fs";
import { basename, dirname } from "node:path";

export const PREVIEW_FILE_CHANGE_DELAY_MS = 300;

export interface FolderWatch {
  close: () => void;
  onError: (listener: () => void) => void;
}

type WatchFolder = (
  folder: string,
  listener: (eventType: string, fileName: string | Buffer | null) => void,
) => FolderWatch;

export interface PreviewFileWatcherOptions {
  onChange: (owner: number, key: string) => void;
  delayMs?: number;
  watchFolder?: WatchFolder;
}

const watchFolderWithNode: WatchFolder = (folder, listener) => {
  const watcher = watch(folder, { persistent: false }, listener);
  return {
    close: () => watcher.close(),
    onError: (onError) => {
      watcher.on("error", onError);
    },
  };
};

export class PreviewFileWatcher {
  #watchers = new Map<number, { key: string; watcher: Pick<FolderWatch, "close">; timer?: NodeJS.Timeout }>();
  readonly #onChange: (owner: number, key: string) => void;
  readonly #delayMs: number;
  readonly #watchFolder: WatchFolder;

  constructor(options: PreviewFileWatcherOptions) {
    this.#onChange = options.onChange;
    this.#delayMs = options.delayMs ?? PREVIEW_FILE_CHANGE_DELAY_MS;
    this.#watchFolder = options.watchFolder ?? watchFolderWithNode;
  }

  watch(owner: number, key: string, path: string): void {
    this.stop(owner);
    const name = basename(path);
    const entry: { key: string; watcher: Pick<FolderWatch, "close">; timer?: NodeJS.Timeout } = {
      key,
      watcher: { close: () => undefined },
    };
    const changed = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (this.#watchers.get(owner) === entry) this.#onChange(owner, key);
      }, this.#delayMs);
    };
    try {
      const watcher = this.#watchFolder(dirname(path), (_eventType, fileName) => {
        if (fileName === null || fileName.toString() === name) changed();
      });
      watcher.onError(() => this.stop(owner));
      entry.watcher = watcher;
    } catch {
      return;
    }
    this.#watchers.set(owner, entry);
  }

  stop(owner: number): void {
    const entry = this.#watchers.get(owner);
    if (!entry) return;
    this.#watchers.delete(owner);
    clearTimeout(entry.timer);
    entry.watcher.close();
  }

  watchedKey(owner: number): string | null {
    return this.#watchers.get(owner)?.key ?? null;
  }

  stopAll(): void {
    for (const owner of [...this.#watchers.keys()]) this.stop(owner);
  }
}
