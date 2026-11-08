import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "Suggerimento",
  "uiBlock.hint.next": "Suggerimento {index}/{count}",
  "uiBlock.hint.label": "Suggerimento {index} di {count}",
} as const satisfies PartialTranslation<typeof source>;
