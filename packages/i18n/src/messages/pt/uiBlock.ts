import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Dica",
  "uiBlock.hint.next": "Dica {index}/{count}",
  "uiBlock.hint.label": "Dica {index} de {count}",
} as const satisfies PartialTranslation<typeof source>;
