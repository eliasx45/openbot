import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewFileWatcher } from "./preview-file-watcher";

type Listener = (eventType: string, fileName: string | Buffer | null) => void;

function fakeFolders() {
  const folders: { folder: string; listener: Listener; closed: boolean }[] = [];
  const watchFolder = (folder: string, listener: Listener) => {
    const entry = { folder, listener, closed: false };
    folders.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
      onError: () => undefined,
    };
  };
  return { folders, watchFolder };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PreviewFileWatcher", () => {
  it("watches the file's folder and reports one change after a burst of writes", () => {
    vi.useFakeTimers();
    const changes: [number, string][] = [];
    const { folders, watchFolder } = fakeFolders();
    const watcher = new PreviewFileWatcher({ onChange: (owner, key) => changes.push([owner, key]), watchFolder });
    watcher.watch(1, "reader\u0000sheet", "/tmp/2 - CS/Recall-Sheet.pdf");
    expect(folders[0]?.folder).toBe("/tmp/2 - CS");

    folders[0]?.listener("change", "Recall-Sheet.pdf");
    vi.advanceTimersByTime(200);
    folders[0]?.listener("change", "Recall-Sheet.pdf");
    vi.advanceTimersByTime(299);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([[1, "reader\u0000sheet"]]);
  });

  it("sees an atomic replace (temp file renamed into place) and ignores other files", () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const { folders, watchFolder } = fakeFolders();
    const watcher = new PreviewFileWatcher({ onChange: (_owner, key) => changes.push(key), watchFolder });
    watcher.watch(1, "sheet", "/tmp/out/Recall-Sheet.pdf");
    folders[0]?.listener("rename", "Recall-Sheet.pdf.tmp123");
    folders[0]?.listener("change", "Recall-Sheet.aux");
    vi.advanceTimersByTime(400);
    expect(changes).toEqual([]);

    folders[0]?.listener("rename", "Recall-Sheet.pdf");
    folders[0]?.listener("rename", Buffer.from("Recall-Sheet.pdf"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual(["sheet"]);
  });

  it("stops the old watch when the window shows another file or stops", () => {
    vi.useFakeTimers();
    const changes: string[] = [];
    const { folders, watchFolder } = fakeFolders();
    const watcher = new PreviewFileWatcher({ onChange: (_owner, key) => changes.push(key), watchFolder });
    watcher.watch(1, "first", "/tmp/a/first.pdf");
    folders[0]?.listener("change", "first.pdf");
    watcher.watch(1, "second", "/tmp/b/second.md");
    expect(folders[0]?.closed).toBe(true);
    vi.advanceTimersByTime(400);
    expect(changes).toEqual([]);
    expect(watcher.watchedKey(1)).toBe("second");

    watcher.stop(1);
    expect(folders[1]?.closed).toBe(true);
    expect(watcher.watchedKey(1)).toBeNull();
  });
});
