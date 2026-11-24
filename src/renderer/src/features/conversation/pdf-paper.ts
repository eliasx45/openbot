import type { PdfPaperMode } from "@openbot/ui/features/conversation/pdf-reading-mode";

export type Rgb = readonly [number, number, number];

export interface PaperPalette {
  paper: Rgb;
  ink: Rgb;
  chroma: number;
  vivid: number;
  photoLight: number;
}

export type ImageQuad = readonly [number, number, number, number, number, number];

type Lab = readonly [number, number, number];

const PAPER_TUNING = {
  dark: { chroma: 0.9, vivid: 0.85, photoLight: 0.86 },
  sepia: { chroma: 0.8, vivid: 0.5, photoLight: 0.94 },
} as const satisfies Record<PdfPaperMode, Omit<PaperPalette, "paper" | "ink">>;

const VIVID_CHROMA_START = 0.07;
const VIVID_CHROMA_FULL = 0.18;
const READABLE_GAP = 0.3;

const IMAGE_SAMPLES_PER_SIDE = 64;
const PAGE_SAMPLE_TARGET = 40_000;
const NEUTRAL_SPREAD = 28;
const LIGHT_LUMA = 204;
const PAPER_LIGHT_SHARE = 0.4;
const PAPER_NEUTRAL_SHARE = 0.85;
const PAPER_COLOUR_BINS = 48;
const DARK_PAGE_LIGHT_SHARE = 0.2;
const DARK_PAGE_LUMA = 0.45;

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
});

export function paperPalette(mode: PdfPaperMode, paper: Rgb, ink: Rgb): PaperPalette {
  return { paper, ink, ...PAPER_TUNING[mode] };
}

export function parseHexColour(value: string): Rgb | null {
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/iu)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function imageQuads(coordinates: ArrayLike<number> | null | undefined): ImageQuad[] {
  if (!coordinates) return [];
  const quads: ImageQuad[] = [];
  for (let index = 0; index + 5 < coordinates.length; index += 6) {
    quads.push([
      coordinates[index] ?? 0,
      coordinates[index + 1] ?? 0,
      coordinates[index + 2] ?? 0,
      coordinates[index + 3] ?? 0,
      coordinates[index + 4] ?? 0,
      coordinates[index + 5] ?? 0,
    ]);
  }
  return quads;
}

function toLab(red: number, green: number, blue: number): Lab {
  const r = LINEAR[red] ?? 0;
  const g = LINEAR[green] ?? 0;
  const b = LINEAR[blue] ?? 0;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function toByte(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const channel = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(channel * 255);
}

function fromLab([lightness, a, b]: Lab): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function vividShare(a: number, b: number): number {
  const chroma = Math.hypot(a, b);
  const share = Math.min(1, Math.max(0, (chroma - VIVID_CHROMA_START) / (VIVID_CHROMA_FULL - VIVID_CHROMA_START)));
  return share * share * (3 - 2 * share);
}

export function createPaperColour(palette: PaperPalette): (red: number, green: number, blue: number) => Rgb {
  const paper = toLab(...palette.paper);
  const ink = toLab(...palette.ink);
  const darkPaper = paper[0] < ink[0];
  const readable = (lightness: number) =>
    darkPaper ? Math.max(lightness, paper[0] + READABLE_GAP) : Math.min(lightness, paper[0] - READABLE_GAP);
  return (red, green, blue) => {
    const [lightness, a, b] = toLab(red, green, blue);
    const share = Math.min(1, Math.max(0, lightness));
    const mapped = ink[0] + (paper[0] - ink[0]) * share;
    const keep = vividShare(a, b) * palette.vivid;
    return fromLab([
      mapped + (readable(lightness) - mapped) * keep,
      ink[1] + (paper[1] - ink[1]) * share + a * palette.chroma,
      ink[2] + (paper[2] - ink[2]) * share + b * palette.chroma,
    ]);
  };
}

function quadPixels(quad: ImageQuad, width: number, height: number) {
  const [x0, y0, x1, y1, x2, y2] = quad;
  return {
    origin: [x0 * width, y0 * height] as const,
    down: [(x1 - x0) * width, (y1 - y0) * height] as const,
    across: [(x2 - x0) * width, (y2 - y0) * height] as const,
  };
}

function isNeutral(red: number, green: number, blue: number): boolean {
  return Math.max(red, green, blue) - Math.min(red, green, blue) <= NEUTRAL_SPREAD;
}

function luma(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function isPhotoRegion(pixels: Uint8ClampedArray, width: number, height: number, quad: ImageQuad): boolean {
  const { origin, down, across } = quadPixels(quad, width, height);
  let samples = 0;
  let light = 0;
  let neutral = 0;
  const bins = new Set<number>();
  for (let row = 0; row < IMAGE_SAMPLES_PER_SIDE; row += 1) {
    const v = (row + 0.5) / IMAGE_SAMPLES_PER_SIDE;
    for (let column = 0; column < IMAGE_SAMPLES_PER_SIDE; column += 1) {
      const u = (column + 0.5) / IMAGE_SAMPLES_PER_SIDE;
      const x = Math.floor(origin[0] + u * across[0] + v * down[0]);
      const y = Math.floor(origin[1] + u * across[1] + v * down[1]);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const offset = (y * width + x) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blue = pixels[offset + 2] ?? 0;
      samples += 1;
      const flat = isNeutral(red, green, blue);
      if (flat) neutral += 1;
      if (flat && luma(red, green, blue) >= LIGHT_LUMA) light += 1;
      bins.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
    }
  }
  if (samples === 0) return false;
  const paperLike =
    light / samples >= PAPER_LIGHT_SHARE &&
    (neutral / samples >= PAPER_NEUTRAL_SHARE || bins.size <= PAPER_COLOUR_BINS);
  return !paperLike;
}

function markQuad(mask: Uint8Array, width: number, height: number, quad: ImageQuad) {
  const { origin, down, across } = quadPixels(quad, width, height);
  const corners = [
    origin,
    [origin[0] + down[0], origin[1] + down[1]],
    [origin[0] + across[0], origin[1] + across[1]],
    [origin[0] + down[0] + across[0], origin[1] + down[1] + across[1]],
  ] as const;
  const left = Math.max(0, Math.floor(Math.min(...corners.map(([x]) => x))));
  const right = Math.min(width, Math.ceil(Math.max(...corners.map(([x]) => x))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map(([, y]) => y))));
  const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(([, y]) => y))));
  const determinant = across[0] * down[1] - across[1] * down[0];
  if (Math.abs(determinant) < 1e-9) return;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const dx = x + 0.5 - origin[0];
      const dy = y + 0.5 - origin[1];
      const u = (dx * down[1] - dy * down[0]) / determinant;
      const v = (across[0] * dy - across[1] * dx) / determinant;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) mask[y * width + x] = 1;
    }
  }
}

function isDarkPage(pixels: Uint8ClampedArray, mask: Uint8Array): boolean {
  const count = mask.length;
  const step = Math.max(1, Math.floor(count / PAGE_SAMPLE_TARGET));
  let samples = 0;
  let light = 0;
  let total = 0;
  for (let index = 0; index < count; index += step) {
    if (mask[index] === 1) continue;
    const offset = index * 4;
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const value = luma(red, green, blue);
    samples += 1;
    total += value;
    if (value >= LIGHT_LUMA && isNeutral(red, green, blue)) light += 1;
  }
  if (samples === 0) return false;
  return light / samples < DARK_PAGE_LIGHT_SHARE && total / samples / 255 < DARK_PAGE_LUMA;
}

export function recolourPage(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  palette: PaperPalette,
  quads: readonly ImageQuad[],
): void {
  const mask = new Uint8Array(width * height);
  for (const quad of quads) {
    if (isPhotoRegion(pixels, width, height, quad)) markQuad(mask, width, height, quad);
  }
  if (isDarkPage(pixels, mask)) return;
  const dim = Uint8ClampedArray.from({ length: 256 }, (_, value) => Math.round(value * palette.photoLight));
  const paperColour = createPaperColour(palette);
  const cache = new Map<number, number>();
  let lastKey = -1;
  let lastValue = 0;
  for (let index = 0, offset = 0; index < mask.length; index += 1, offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    if (mask[index] === 1) {
      pixels[offset] = dim[red] ?? red;
      pixels[offset + 1] = dim[green] ?? green;
      pixels[offset + 2] = dim[blue] ?? blue;
      continue;
    }
    const key = (red << 16) | (green << 8) | blue;
    if (key !== lastKey) {
      let value = cache.get(key);
      if (value === undefined) {
        const [r, g, b] = paperColour(red, green, blue);
        value = (r << 16) | (g << 8) | b;
        cache.set(key, value);
      }
      lastKey = key;
      lastValue = value;
    }
    pixels[offset] = lastValue >> 16;
    pixels[offset + 1] = (lastValue >> 8) & 255;
    pixels[offset + 2] = lastValue & 255;
  }
}
