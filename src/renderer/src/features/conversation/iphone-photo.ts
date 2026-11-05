// Fork (docs/fork/FEATURES.md entry 36): "From iPhone" in the + menu of every message box: the main chat,
// a thread tab, the side thread and the Tasks page. A photo taken on the iPhone through Continuity
// Camera comes back as a file, which each message box adds the way it adds a pasted image.

import type { ServerSummary } from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import type { useText } from "@openbot/ui/text";

type Translate = ReturnType<typeof useText>["t"];

const NOTICES = {
  noDevice: "composer.iphonePhoto.noDevice",
  timeout: "composer.iphonePhoto.timeout",
  unavailable: "composer.iphonePhoto.unavailable",
  failed: "composer.iphonePhoto.failed",
} as const;

/** Only this Mac's own server pairs with the iPhone. */
export function iphonePhotoAvailable(
  server: Pick<ServerSummary, "kind"> | undefined,
  platform: string | undefined,
): boolean {
  return server?.kind === "local" && platform === "darwin";
}

/** Opens Continuity Camera's menu and waits for the photo. Undefined: no photo, with a notice when it failed. */
export async function takeIphonePhoto(t: Translate): Promise<File | undefined> {
  const waiting = toast.loading(t("composer.iphonePhoto.waiting"));
  try {
    const result = await window.openbot.agent.takeIphonePhoto();
    if (result.outcome === "picked")
      return new File([new Uint8Array(result.bytes)], result.name, { type: "image/jpeg" });
    if (result.outcome !== "dismissed") toast.warning(t(NOTICES[result.outcome]));
  } catch {
    toast.warning(t("composer.iphonePhoto.failed"));
  } finally {
    toast.dismiss(waiting);
  }
  return undefined;
}
