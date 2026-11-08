import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/uiBlock";

export const messages = {
  "uiBlock.confirm.autoActionClock": "{action} · {time}",
  "uiBlock.hint.show": "ヒント",
  "uiBlock.hint.next": "ヒント {index}/{count}",
  "uiBlock.hint.label": "ヒント {index}/{count}",
  "uiBlock.form.other": "その他",
  "uiBlock.form.otherPlaceholder": "自分の回答",
  "uiBlock.clip.note": "ここにメモ",
  "uiBlock.clip.notePlaceholder": "このフレームで何を変えますか？",
  "uiBlock.clip.addNote": "メモを追加",
  "uiBlock.clip.removeNote": "メモを削除",
} as const satisfies PartialTranslation<typeof source>;
