import { describe, expect, it } from "vitest";
import { parsePdfPositions, pdfScrollDelta, pdfScrollPosition, rememberPdfPosition } from "./pdf-positions";

const PAGES = [
  { top: 0, height: 1000 },
  { top: 1010, height: 1000 },
  { top: 2020, height: 1000 },
  { top: 3030, height: 1000 },
];

describe("PDF scroll position", () => {
  it("names the page at the top of the view and how far into it the view is", () => {
    expect(pdfScrollPosition(0, PAGES)).toEqual({ page: 1, offset: 0 });
    expect(pdfScrollPosition(3280, PAGES)).toEqual({ page: 4, offset: 0.25 });
    expect(pdfScrollPosition(1005, PAGES)).toEqual({ page: 2, offset: 0 });
    expect(pdfScrollPosition(9000, PAGES)).toEqual({ page: 4, offset: 1 });
    expect(pdfScrollPosition(0, [])).toBeNull();
  });

  it("scrolls back to the same page and place after the pages are laid out again", () => {
    const shown = pdfScrollPosition(3280, PAGES);
    if (!shown) throw new Error("no position");
    const wider = PAGES.map((_, index) => ({ top: index * 1510, height: 1500 }));
    expect(pdfScrollDelta(shown, 0, wider)).toBe(3 * 1510 + 375);
    expect(pdfScrollDelta({ page: 4, offset: 0.25 }, 1000, PAGES)).toBe(2280);
    expect(pdfScrollDelta({ page: 9, offset: 0 }, 0, PAGES)).toBe(3030);
    expect(pdfScrollDelta({ page: 1, offset: 0 }, 0, [])).toBeNull();
  });
});

describe("stored PDF positions", () => {
  it("reads valid entries and skips broken ones", () => {
    const raw = JSON.stringify([
      ["reader\u0000attachment\u0000a", { page: 4, offset: 0.25, scale: null }],
      ["reader\u0000shared\u0000/tmp/2 - CS/Recall-Sheet.pdf", { page: 2, offset: 3, scale: 1.5 }],
      ["bad-page", { page: 0, offset: 0, scale: null }],
      ["bad-scale", { page: 1, offset: 0, scale: -1 }],
      [7, { page: 1, offset: 0, scale: null }],
    ]);
    expect([...parsePdfPositions(raw)]).toEqual([
      ["reader\u0000attachment\u0000a", { page: 4, offset: 0.25, scale: null }],
      ["reader\u0000shared\u0000/tmp/2 - CS/Recall-Sheet.pdf", { page: 2, offset: 1, scale: 1.5 }],
    ]);
    expect(parsePdfPositions("not json").size).toBe(0);
    expect(parsePdfPositions(null).size).toBe(0);
  });

  it("keeps the newest positions up to the limit", () => {
    const positions = parsePdfPositions(null);
    rememberPdfPosition(positions, "a", { page: 1, offset: 0, scale: null }, 2);
    rememberPdfPosition(positions, "b", { page: 2, offset: 0, scale: null }, 2);
    rememberPdfPosition(positions, "a", { page: 3, offset: 0, scale: null }, 2);
    rememberPdfPosition(positions, "c", { page: 4, offset: 0, scale: null }, 2);
    expect([...positions.keys()]).toEqual(["a", "c"]);
    expect(positions.get("a")?.page).toBe(3);
  });
});
