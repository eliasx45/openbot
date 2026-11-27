const KEPT_FRAME_LIMIT = 3;
const FINGERPRINT_SAMPLE = 65_536;
const FINGERPRINT_STRIDE_COUNT = 4_096;

interface KeptFrame {
  key: string;
  identity: string;
  frame: HTMLIFrameElement;
}

const keptFrames: KeptFrame[] = [];
let parking: HTMLElement | undefined;

type MovingParent = ParentNode & { moveBefore?: (node: Node, child: Node | null) => void };

export function canKeepFrames(parent: ParentNode): boolean {
  const moving: MovingParent = parent;
  return typeof moving.moveBefore === "function";
}

export function moveFrameInto(parent: ParentNode, frame: HTMLIFrameElement): void {
  const moving: MovingParent = parent;
  if (frame.parentNode === parent) return;
  if (typeof moving.moveBefore === "function" && frame.isConnected && parent.isConnected)
    moving.moveBefore(frame, null);
  else parent.appendChild(frame);
}

function parkingLot(owner: Document): HTMLElement {
  if (parking?.isConnected && parking.ownerDocument === owner) return parking;
  const lot = owner.createElement("div");
  lot.dataset.pdfFrameParking = "";
  lot.setAttribute("aria-hidden", "true");
  lot.inert = true;
  Object.assign(lot.style, {
    position: "fixed",
    left: "-200vw",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
  });
  owner.body.append(lot);
  parking = lot;
  return lot;
}

function dropFrame(index: number): void {
  const [dropped] = keptFrames.splice(index, 1);
  dropped?.frame.remove();
}

export function takeKeptFrame(key: string, identity: string): HTMLIFrameElement | null {
  const index = keptFrames.findIndex((kept) => kept.key === key);
  if (index < 0) return null;
  const kept = keptFrames[index];
  if (!kept || kept.identity !== identity || !kept.frame.isConnected) {
    dropFrame(index);
    return null;
  }
  keptFrames.splice(index, 1);
  kept.frame.style.removeProperty("width");
  kept.frame.style.removeProperty("height");
  return kept.frame;
}

export function keepFrame(key: string, identity: string, frame: HTMLIFrameElement): void {
  const existing = keptFrames.findIndex((kept) => kept.key === key);
  if (existing >= 0 && keptFrames[existing]?.frame !== frame) dropFrame(existing);
  const owner = frame.ownerDocument;
  if (!frame.isConnected || !canKeepFrames(owner.body)) {
    frame.remove();
    return;
  }
  const { width, height } = frame.getBoundingClientRect();
  if (width > 0 && height > 0) {
    frame.style.width = `${Math.round(width)}px`;
    frame.style.height = `${Math.round(height)}px`;
  }
  moveFrameInto(parkingLot(owner), frame);
  keptFrames.push({ key, identity, frame });
  while (keptFrames.length > KEPT_FRAME_LIMIT) dropFrame(0);
}

export function keptFrameCount(): number {
  return keptFrames.length;
}

export function clearKeptFrames(): void {
  while (keptFrames.length > 0) dropFrame(0);
  parking?.remove();
  parking = undefined;
}

export function pdfBytesFingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const length = bytes.byteLength;
  const head = Math.min(length, FINGERPRINT_SAMPLE);
  for (let index = 0; index < head; index += 1) mix(bytes[index] ?? 0);
  for (let index = Math.max(head, length - FINGERPRINT_SAMPLE); index < length; index += 1) mix(bytes[index] ?? 0);
  const stride = Math.max(1, Math.floor(length / FINGERPRINT_STRIDE_COUNT));
  for (let index = 0; index < length; index += stride) mix(bytes[index] ?? 0);
  return `bytes:${length}:${hash.toString(16)}`;
}
