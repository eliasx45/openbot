import {
  clearKeptFrames,
  keepFrame,
  keptFrameCount,
  pdfBytesFingerprint,
  takeKeptFrame,
} from "@openbot/ui/features/conversation/pdf-frame-keeper";
import { afterEach, describe, expect, it } from "vitest";

type MovingElement = Element & { moveBefore?: (node: Node, child: Node | null) => void };
const prototype: MovingElement = Element.prototype;

function withMoveBefore() {
  const moves: Node[] = [];
  prototype.moveBefore = function moveBefore(this: Element, node: Node, child: Node | null) {
    moves.push(node);
    this.insertBefore(node, child);
  };
  return moves;
}

function shownFrame(src: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const frame = document.createElement("iframe");
  frame.src = src;
  host.append(frame);
  return { host, frame };
}

afterEach(() => {
  clearKeptFrames();
  Reflect.deleteProperty(prototype, "moveBefore");
  document.body.replaceChildren();
});

describe("kept PDF frames", () => {
  it("parks a tab's frame with moveBefore and gives the same frame back for the same file", () => {
    const moves = withMoveBefore();
    const { host, frame } = shownFrame("openbot-attachment://file/a");
    keepFrame("reader\u0000attachment\u0000a", "openbot-attachment://file/a", frame);
    expect(moves).toEqual([frame]);
    expect(frame.isConnected).toBe(true);
    expect(host.contains(frame)).toBe(false);
    expect(document.querySelector("[data-pdf-frame-parking] iframe")).toBe(frame);

    expect(takeKeptFrame("reader\u0000attachment\u0000a", "openbot-attachment://file/a")).toBe(frame);
    expect(keptFrameCount()).toBe(0);
    expect(takeKeptFrame("reader\u0000attachment\u0000a", "openbot-attachment://file/a")).toBeNull();
  });

  it("drops a kept frame when the file changed", () => {
    withMoveBefore();
    const { frame } = shownFrame("blob:one");
    keepFrame("tab", "bytes:4:1", frame);
    expect(takeKeptFrame("tab", "bytes:4:2")).toBeNull();
    expect(frame.isConnected).toBe(false);
    expect(keptFrameCount()).toBe(0);
  });

  it("does not keep frames when a move would reload them", () => {
    const { frame } = shownFrame("blob:one");
    keepFrame("tab", "bytes:4:1", frame);
    expect(frame.isConnected).toBe(false);
    expect(takeKeptFrame("tab", "bytes:4:1")).toBeNull();
  });

  it("keeps at most three frames, dropping the oldest", () => {
    withMoveBefore();
    const frames = ["a", "b", "c", "d"].map((key) => {
      const { frame } = shownFrame(`openbot-attachment://file/${key}`);
      keepFrame(key, key, frame);
      return frame;
    });
    expect(keptFrameCount()).toBe(3);
    expect(frames[0]?.isConnected).toBe(false);
    expect(takeKeptFrame("a", "a")).toBeNull();
    expect(takeKeptFrame("d", "d")).toBe(frames[3]);
  });
});

describe("PDF bytes fingerprint", () => {
  it("changes when the bytes change and stays the same for equal bytes", () => {
    const bytes = new Uint8Array(300_000).map((_, index) => index % 251);
    const same = bytes.slice();
    const changed = bytes.slice();
    changed[299_990] = 7;
    expect(pdfBytesFingerprint(same)).toBe(pdfBytesFingerprint(bytes));
    expect(pdfBytesFingerprint(changed)).not.toBe(pdfBytesFingerprint(bytes));
    expect(pdfBytesFingerprint(bytes.subarray(0, 10))).not.toBe(pdfBytesFingerprint(bytes.subarray(0, 11)));
  });
});
