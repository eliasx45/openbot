import { type ChatMath, chatMathStart, inlineChatMath } from "@openbot/contracts/chat-math";
import { createMemo, For } from "solid-js";
import { MathFormula } from "../MathFormula";

type Part = { text: string } | { math: ChatMath };

/** `text` cut into plain text and the math in it, with the delimiters of the chat. */
function parts(text: string): Part[] {
  const result: Part[] = [];
  let plain = "";
  let rest = text;
  for (;;) {
    const start = chatMathStart(rest);
    if (start === undefined) break;
    plain += rest.slice(0, start);
    rest = rest.slice(start);
    const math = inlineChatMath(rest);
    if (!math) {
      plain += rest.slice(0, 1);
      rest = rest.slice(1);
      continue;
    }
    if (plain) result.push({ text: plain });
    plain = "";
    result.push({ math });
    rest = rest.slice(math.raw.length);
  }
  plain += rest;
  if (plain) result.push({ text: plain });
  return result;
}

/**
 * A plain text of a block, such as a title or a label, with its LaTeX math typeset. Nothing else in
 * the text is read: no Markdown, no HTML.
 */
export function UiMathText(props: { text: string }) {
  const cut = createMemo(() => (chatMathStart(props.text) === undefined ? null : parts(props.text)));
  return (
    <>
      {cut() === null ? (
        props.text
      ) : (
        <For each={cut()}>
          {(part) =>
            "math" in part ? <MathFormula tex={part.math.tex} raw={part.math.raw} display={false} /> : part.text
          }
        </For>
      )}
    </>
  );
}
