import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/** The stored choice. A file without the switch, or no file, reads as off. */
export interface StoredComputerUseChromeProfile {
  existingProfile: boolean;
}

/**
 * Whether the Computer Use driver starts with `--grant existing-profile`, so that agents can attach
 * to the user's own signed-in Chrome (fork #88). Main reads it at each start of the driver.
 */
export type ComputerUseChromeProfileStore = PreferenceStore<StoredComputerUseChromeProfile>;

export function createComputerUseChromeProfileStore(path: string): ComputerUseChromeProfileStore {
  return new PreferenceStore({
    path,
    defaultValue: { existingProfile: false },
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && isBoolean(parsed.existingProfile)
        ? { existingProfile: parsed.existingProfile }
        : null,
  });
}
