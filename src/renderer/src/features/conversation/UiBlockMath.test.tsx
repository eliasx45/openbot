import {
  UI_BLOCK_SUBMIT_ACTION_ID,
  type UiBlockResponse,
  type UiBlockSpec,
  type UiChoiceBlock as UiChoiceSpec,
  type UiConfirmBlock as UiConfirmSpec,
  type UiFormBlock as UiFormSpec,
  uiBlockOutcomeText,
} from "@openbot/contracts/ui-blocks";
import { UiBlockingBlock } from "@openbot/ui/features/conversation/ui-blocks/UiBlockingBlock";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { beforeAll, describe, expect, it, vi } from "vitest";

function typesetTex(): string[] {
  return Array.from(document.querySelectorAll("annotation"), (annotation) => annotation.textContent ?? "");
}

function show(spec: UiBlockSpec, response?: UiBlockResponse) {
  const state = response
    ? { status: "answered" as const, response, outcome: uiBlockOutcomeText(spec, response) }
    : { status: "pending" as const };
  return render(() => <UiBlockingBlock spec={spec} state={state} onRespond={vi.fn()} />);
}

beforeAll(async () => {
  show({ type: "confirm", title: "$x$", actions: [{ id: "ok", label: "OK" }] });
  await waitFor(() => expect(typesetTex()).toEqual(["x"]));
  cleanup();
});

describe("math in the plain text fields of a card", () => {
  it("typesets the description of a choice option", async () => {
    const spec: UiChoiceSpec = {
      type: "choice",
      title: "Which antiderivative?",
      options: [{ id: "cube", label: "Cube", meta: String.raw`$F(1) = \frac{1}{3}$` }],
    };
    show(spec);
    await waitFor(() => expect(typesetTex()).toContain(String.raw`F(1) = \frac{1}{3}`));
  });

  it("typesets the label and the value of a confirm field", async () => {
    const spec: UiConfirmSpec = {
      type: "confirm",
      title: "Use this sum?",
      fields: [{ label: "Sum $S_n$", value: String.raw`$\frac{n(n+1)}{2}$` }],
      actions: [{ id: "use", label: "Use it", style: "primary" }],
    };
    show(spec);
    await waitFor(() => expect(typesetTex()).toEqual(expect.arrayContaining(["S_n", String.raw`\frac{n(n+1)}{2}`])));
  });

  it("typesets the labels and the answers in the rows of an answered form with a secret field", async () => {
    const spec: UiFormSpec = {
      type: "form",
      title: "Solve",
      fields: [
        { id: "root", kind: "text", label: "Positive root $x_1$" },
        { id: "sign", kind: "segmented", label: "Sign", options: ["$+$", "$-$"] },
        { id: "key", kind: "text", label: "Course key", secret: true },
      ],
    };
    show(spec, { actionId: UI_BLOCK_SUBMIT_ACTION_ID, values: { root: "2", sign: "$-$" } });
    await waitFor(() => expect(typesetTex()).toEqual(expect.arrayContaining(["x_1", "-"])));
  });

  it("typesets the outcome of an answered card", async () => {
    const spec: UiConfirmSpec = {
      type: "confirm",
      title: "Pick a bound",
      fields: [{ label: "Bound", select: "bound", options: ["$n^2$", "$2^n$"] }],
      actions: [{ id: "use", label: "Use it", style: "primary" }],
    };
    show(spec, { actionId: "use", values: { bound: "$2^n$" } });
    await waitFor(() => expect(typesetTex()).toContain("2^n"));
  });

  it("typesets the caption of a card picture", async () => {
    const spec: UiChoiceSpec = {
      type: "choice",
      title: "Which area?",
      options: [{ id: "a", label: "A" }],
      media: [{ path: "/Users/demo/plots/parabola.png", caption: "The area under $y = x^2$" }],
    };
    show(spec);
    await waitFor(() => expect(typesetTex()).toContain("y = x^2"));
  });
});
