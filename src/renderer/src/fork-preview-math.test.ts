// @vitest-environment node
import { markdownPlainText, markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { describe, expect, it } from "vitest";
import { liveActivityMarkdown } from "../../../packages/team-client/src/live-activity-text";

describe("math in a one-line preview", () => {
  it.each([
    [String.raw`The answer is $\frac{1}{2}$.`, "The answer is 1/2."],
    [String.raw`So $x^2 + y_1 \le \sqrt{3}$ holds.`, "So x² + y₁ ≤ √3 holds."],
    [String.raw`$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`, "(1 2; 3 4)"],
    [String.raw`$\frac{1}{\sqrt{2}}\begin{bmatrix}1&1\\1&-1\end{bmatrix}$`, "1/√2 [1 1; 1 -1]"],
    [String.raw`$\{v \in \mathbb{R}^3 : \|v\| \le 1\}$`, "{v ∈ ℝ³ : ‖v‖ ≤ 1}"],
    [String.raw`$\vec{v}\cdot\hat{x}$`, "v⃗·x̂"],
    [String.raw`$f(x) = \begin{cases}1 & x>0\\0 & \text{else}\end{cases}$`, "f(x) = 1 x>0; 0 else"],
  ])("shows %s as %s", (body, text) => {
    expect(markdownPreviewText(body)).toBe(text);
  });

  it("keeps the TeX when the text is copied", () => {
    expect(markdownPlainText(String.raw`The answer is $\frac{1}{2}$.`)).toBe(String.raw`The answer is \frac{1}{2}.`);
  });

  it("shows a matrix in the Live Activity the same way", () => {
    expect(liveActivityMarkdown(String.raw`Result: $\begin{pmatrix}1&2\\3&4\end{pmatrix}$`, 200)).toBe(
      "Result: (1 2; 3 4)",
    );
  });
});
