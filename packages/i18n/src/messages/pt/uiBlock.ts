import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.status.waiting": "Aguardando você",
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Dica",
  "uiBlock.hint.next": "Dica {index}/{count}",
  "uiBlock.hint.label": "Dica {index} de {count}",
  "uiBlock.form.other": "Outra",
  "uiBlock.form.otherPlaceholder": "Sua própria resposta",
  "uiBlock.clip.note": "Nota aqui",
  "uiBlock.clip.notePlaceholder": "O que deve mudar neste quadro?",
  "uiBlock.clip.addNote": "Adicionar nota",
  "uiBlock.clip.removeNote": "Remover nota",
} as const satisfies PartialTranslation<typeof source>;
