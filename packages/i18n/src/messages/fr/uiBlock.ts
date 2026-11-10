import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.status.waiting": "En attente de vous",
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Indice",
  "uiBlock.hint.next": "Indice {index}/{count}",
  "uiBlock.hint.label": "Indice {index} sur {count}",
  "uiBlock.form.other": "Autre",
  "uiBlock.form.otherPlaceholder": "Votre propre réponse",
  "uiBlock.clip.note": "Note ici",
  "uiBlock.clip.notePlaceholder": "Que faut-il changer sur cette image ?",
  "uiBlock.clip.addNote": "Ajouter la note",
  "uiBlock.clip.removeNote": "Retirer la note",
} as const satisfies PartialTranslation<typeof source>;
