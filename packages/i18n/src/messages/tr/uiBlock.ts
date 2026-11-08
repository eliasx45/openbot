import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "İpucu",
  "uiBlock.hint.next": "İpucu {index}/{count}",
  "uiBlock.hint.label": "İpucu {index}/{count}",
  "uiBlock.form.other": "Diğer",
  "uiBlock.form.otherPlaceholder": "Kendi cevabın",
  "uiBlock.clip.note": "Buraya not",
  "uiBlock.clip.notePlaceholder": "Bu karede ne değişmeli?",
  "uiBlock.clip.addNote": "Not ekle",
  "uiBlock.clip.removeNote": "Notu kaldır",
} as const satisfies PartialTranslation<typeof source>;
