/**
 * Fork (docs/fork/FEATURES.md entry 36): a photo from the iPhone through macOS Continuity Camera, for the
 * message box. Only this computer's own server has the call: the iPhone pairs with this Mac.
 */

import { isDynamicRecord } from "./runtime-values";

/**
 * `picked`: the photo is in `bytes`. `dismissed`: the menu closed with no choice. `noDevice`: no iPhone
 * was in reach. `timeout`: no photo came after a choice. `unavailable`: this computer has no Continuity
 * Camera (not macOS, or the helper is missing). `failed`: the photo could not be read.
 */
export type IphonePhotoResult =
  | { outcome: "picked"; name: string; bytes: Uint8Array }
  | { outcome: "dismissed" | "noDevice" | "timeout" | "unavailable" | "failed" };

export function decodeIphonePhotoResult(value: unknown): IphonePhotoResult {
  if (!isDynamicRecord(value)) throw new Error("Invalid iPhone photo.");
  const outcome = value.outcome;
  if (outcome === "picked") {
    if (typeof value.name !== "string" || !value.name || !(value.bytes instanceof Uint8Array))
      throw new Error("Invalid iPhone photo.");
    return { outcome, name: value.name, bytes: value.bytes };
  }
  if (
    outcome === "dismissed" ||
    outcome === "noDevice" ||
    outcome === "timeout" ||
    outcome === "unavailable" ||
    outcome === "failed"
  )
    return { outcome };
  throw new Error("Invalid iPhone photo.");
}
