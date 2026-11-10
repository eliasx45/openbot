import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.status.waiting": "Esperándote",
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Pista",
  "uiBlock.hint.next": "Pista {index}/{count}",
  "uiBlock.hint.label": "Pista {index} de {count}",
  "uiBlock.form.other": "Otra",
  "uiBlock.form.otherPlaceholder": "Tu propia respuesta",
  "uiBlock.clip.note": "Nota aquí",
  "uiBlock.clip.notePlaceholder": "¿Qué debe cambiar en este fotograma?",
  "uiBlock.clip.addNote": "Añadir nota",
  "uiBlock.clip.removeNote": "Quitar nota",
} as const satisfies PartialTranslation<typeof source>;
