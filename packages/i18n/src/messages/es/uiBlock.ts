import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Pista",
  "uiBlock.hint.next": "Pista {index}/{count}",
  "uiBlock.hint.label": "Pista {index} de {count}",
} as const satisfies PartialTranslation<typeof source>;
