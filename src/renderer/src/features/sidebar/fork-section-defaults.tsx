// Fork (docs/fork/FEATURES.md #108): the shared defaults dialog of a sidebar section, on this computer.
import type { SectionDefaultsCalls } from "@openbot/ui/features/sidebar/SectionDefaultsDialog";
import { SectionDefaultsDialog } from "@openbot/ui/features/sidebar/SectionDefaultsDialog";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

const [openSectionId, setOpenSectionId] = createSignal<string | null>(null);
const [savedRevision, setSavedRevision] = createSignal(0);

export function openSectionDefaults(sectionId: string): void {
  setOpenSectionId(sectionId);
}

export { savedRevision as sectionDefaultsRevision };

const calls: SectionDefaultsCalls = {
  load: (sectionId) => window.openbot.agent.getSectionDefaults(sectionId),
  save: async (input) => {
    const saved = await window.openbot.agent.updateSectionDefaults(input);
    setSavedRevision((revision) => revision + 1);
    return saved;
  },
};

export function SectionDefaultsHost(): JSX.Element {
  return (
    <Show when={openSectionId()}>
      {(sectionId) => (
        <SectionDefaultsDialog sectionId={sectionId()} calls={calls} onClose={() => setOpenSectionId(null)} />
      )}
    </Show>
  );
}
