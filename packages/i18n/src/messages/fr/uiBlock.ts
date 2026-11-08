import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Indice",
  "uiBlock.hint.next": "Indice {index}/{count}",
  "uiBlock.hint.label": "Indice {index} sur {count}",
} as const satisfies PartialTranslation<typeof source>;
