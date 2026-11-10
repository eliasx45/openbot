import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.status.waiting": "Tocca a te",
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Suggerimento",
  "uiBlock.hint.next": "Suggerimento {index}/{count}",
  "uiBlock.hint.label": "Suggerimento {index} di {count}",
  "uiBlock.form.other": "Altro",
  "uiBlock.form.otherPlaceholder": "La tua risposta",
  "uiBlock.clip.note": "Nota qui",
  "uiBlock.clip.notePlaceholder": "Cosa deve cambiare in questo fotogramma?",
  "uiBlock.clip.addNote": "Aggiungi nota",
  "uiBlock.clip.removeNote": "Rimuovi nota",
} as const satisfies PartialTranslation<typeof source>;
