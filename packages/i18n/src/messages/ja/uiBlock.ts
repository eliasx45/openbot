import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "ヒント",
  "uiBlock.hint.next": "ヒント {index}/{count}",
  "uiBlock.hint.label": "ヒント {index}/{count}",
} as const satisfies PartialTranslation<typeof source>;
