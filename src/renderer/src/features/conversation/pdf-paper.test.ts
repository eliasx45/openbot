import { pdfReadingMode } from "@openbot/ui/features/conversation/pdf-reading-mode";
import { describe, expect, it } from "vitest";
import {
  createPaperColour,
  type ImageQuad,
  imageQuads,
  isPhotoRegion,
  paperPalette,
  parseHexColour,
  type Rgb,
  recolourPage,
} from "./pdf-paper";

const DARK = paperPalette("dark", [38, 38, 38], [210, 210, 210]);
const SEPIA = paperPalette("sepia", [221, 208, 182], [58, 46, 34]);

function canvas(width: number, height: number, paint: (x: number, y: number) => Rgb): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = paint(x, y);
      pixels.set([red, green, blue, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

function pixel(pixels: Uint8ClampedArray, width: number, x: number, y: number): Rgb {
  const offset = (y * width + x) * 4;
  return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
}

function expectNear(actual: Rgb, expected: Rgb) {
  for (const [index, channel] of actual.entries()) {
    expect(Math.abs(channel - (expected[index] ?? 0))).toBeLessThanOrEqual(2);
  }
}

function photo(x: number, y: number): Rgb {
  return [(x * 53 + y * 17) % 256, (x * 29 + y * 91) % 200, (x * 71 + y * 37) % 160];
}

const RIGHT_HALF: ImageQuad = [0.5, 0, 0.5, 1, 1, 0];

describe("PDF reading mode", () => {
  it("reads a saved mode and falls back to off", () => {
    expect(pdfReadingMode("dark")).toBe("dark");
    expect(pdfReadingMode("sepia")).toBe("sepia");
    expect(pdfReadingMode("negative")).toBe("off");
    expect(pdfReadingMode(null)).toBe("off");
  });

  it("parses palette tokens", () => {
    expect(parseHexColour(" #262626")).toEqual([38, 38, 38]);
    expect(parseHexColour("#fa0")).toEqual([255, 170, 0]);
    expect(parseHexColour("rgb(1, 2, 3)")).toBeNull();
  });
});

describe("dark paper colours", () => {
  const colour = createPaperColour(DARK);

  it("turns white paper into the paper colour and black ink into the ink colour", () => {
    expectNear(colour(255, 255, 255), DARK.paper);
    expectNear(colour(0, 0, 0), DARK.ink);
  });

  it("keeps the hue of coloured text and makes it lighter than the paper", () => {
    const [red, green, blue] = colour(30, 60, 200);
    expect(blue).toBeGreaterThan(red);
    expect(blue).toBeGreaterThan(green);
    expect(red + green + blue).toBeGreaterThan(3 * DARK.paper[0] + 150);
    const [warmRed, warmGreen, warmBlue] = colour(200, 30, 30);
    expect(warmRed).toBeGreaterThan(warmGreen + 60);
    expect(warmRed).toBeGreaterThan(warmBlue + 60);
  });

  it("keeps a vivid fill close to its own brightness instead of a negative", () => {
    const [red, green, blue] = colour(255, 140, 0);
    expect(red).toBeGreaterThan(200);
    expect(green).toBeGreaterThan(90);
    expect(blue).toBeLessThan(60);
  });

  it("maps sepia paper to a warm page with dark brown ink", () => {
    const sepia = createPaperColour(SEPIA);
    expectNear(sepia(255, 255, 255), SEPIA.paper);
    expectNear(sepia(0, 0, 0), SEPIA.ink);
  });
});

describe("page recolouring", () => {
  const width = 40;
  const height = 20;

  it("recolours the page but keeps a photo natural, only dimmed", () => {
    const pixels = canvas(width, height, (x, y) => (x >= width / 2 ? photo(x, y) : [255, 255, 255]));
    pixels.set([0, 0, 0], (5 * width + 5) * 4);
    recolourPage(pixels, width, height, DARK, [RIGHT_HALF]);
    expectNear(pixel(pixels, width, 1, 1), DARK.paper);
    expectNear(pixel(pixels, width, 5, 5), DARK.ink);
    const [red, green, blue] = photo(30, 7);
    expectNear(pixel(pixels, width, 30, 7), [red * 0.86, green * 0.86, blue * 0.86]);
  });

  it("treats a scanned or line-art image as paper", () => {
    const scan = canvas(width, height, (x, y) =>
      x >= width / 2 && (x + y) % 9 === 0 ? [20, 20, 20] : [250, 250, 248],
    );
    expect(isPhotoRegion(scan, width, height, RIGHT_HALF)).toBe(false);
    recolourPage(scan, width, height, DARK, [RIGHT_HALF]);
    expectNear(pixel(scan, width, 31, 1), DARK.paper);
    const photoPage = canvas(width, height, photo);
    expect(isPhotoRegion(photoPage, width, height, RIGHT_HALF)).toBe(true);
  });

  it("leaves a page that is already dark unchanged", () => {
    const slide = canvas(width, height, (x) => (x % 7 === 0 ? [230, 230, 230] : [24, 28, 40]));
    const before = slide.slice();
    recolourPage(slide, width, height, DARK, []);
    expect(slide).toEqual(before);
  });

  it("reads the image corners that pdf.js records", () => {
    expect(imageQuads(new Float32Array([0.5, 0, 0.5, 1, 1, 0, 0, 0]))).toEqual([RIGHT_HALF]);
    expect(imageQuads(null)).toEqual([]);
  });
});
