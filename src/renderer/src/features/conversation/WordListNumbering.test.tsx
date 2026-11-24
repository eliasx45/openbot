import { WordFilePreview } from "@openbot/ui/features/conversation/WordFilePreview";
import { render } from "@solidjs/testing-library";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

const WORD = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function item(text: string, level: number): string {
  return `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function paragraph(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
}

function docx(body: string): Uint8Array {
  return zipSync({
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${WORD}><w:body>${body}</w:body></w:document>`),
    "word/numbering.xml": strToU8(
      `<?xml version="1.0"?><w:numbering ${WORD}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    ),
  });
}

function shownNumbers(container: HTMLElement): Record<string, number> {
  const numbers: Record<string, number> = {};
  for (const list of container.querySelectorAll("ol")) {
    Array.from(list.children).forEach((entry, index) => {
      numbers[entry.textContent ?? ""] = list.start + index;
    });
  }
  return numbers;
}

describe("a numbered list in a Word document", () => {
  it("goes on counting after bullet sub-items", () => {
    const { container } = render(() => (
      <WordFilePreview
        bytes={docx(
          [
            item("Open the file", 0),
            item("Fill the form", 0),
            item("Name", 1),
            item("Date", 1),
            item("Save it", 0),
          ].join(""),
        )}
      />
    ));
    expect(shownNumbers(container)).toEqual({ "Open the file": 1, "Fill the form": 2, "Save it": 3 });
  });

  it("goes on counting after a paragraph between two items", () => {
    const { container } = render(() => (
      <WordFilePreview
        bytes={docx(
          [item("Tag the build", 0), paragraph("Wait for the checks."), item("Publish the notes", 0)].join(""),
        )}
      />
    ));
    expect(shownNumbers(container)).toEqual({ "Tag the build": 1, "Publish the notes": 2 });
  });

  it("starts a sub-list at 1 again under the next item", () => {
    const { container } = render(() => (
      <WordFilePreview
        bytes={docx(
          [item("Step one", 0), item("one a", 1), item("one b", 1), item("Step two", 0), item("two a", 1)].join(""),
        )}
      />
    ));
    expect(shownNumbers(container)).toEqual({ "Step one": 1, "Step two": 2 });
    expect(Array.from(container.querySelectorAll("ul li"), (entry) => entry.textContent)).toEqual([
      "one a",
      "one b",
      "two a",
    ]);
  });
});
