import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "İpucu",
  "uiBlock.hint.next": "İpucu {index}/{count}",
  "uiBlock.hint.label": "İpucu {index}/{count}",
} as const satisfies PartialTranslation<typeof source>;
