import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.status.waiting": "Wartet auf dich",
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Tipp",
  "uiBlock.hint.next": "Tipp {index}/{count}",
  "uiBlock.hint.label": "Tipp {index} von {count}",
  "uiBlock.form.other": "Andere",
  "uiBlock.form.otherPlaceholder": "Eigene Antwort",
  "uiBlock.clip.note": "Notiz hier",
  "uiBlock.clip.notePlaceholder": "Was soll sich in diesem Bild ändern?",
  "uiBlock.clip.addNote": "Notiz hinzufügen",
  "uiBlock.clip.removeNote": "Notiz entfernen",
} as const satisfies PartialTranslation<typeof source>;
