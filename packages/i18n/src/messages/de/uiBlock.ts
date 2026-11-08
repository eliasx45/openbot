import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Tipp",
  "uiBlock.hint.next": "Tipp {index}/{count}",
  "uiBlock.hint.label": "Tipp {index} von {count}",
} as const satisfies PartialTranslation<typeof source>;
