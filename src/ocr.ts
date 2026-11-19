// Image preparation for OCR, without an image library: grim writes PPM, this
// turns it into a grayscale PGM that tesseract reads. Measured on captures from
// this machine (see DESIGN.md, "OCR").

/** An 8-bit grayscale image, row-major. */
export type Gray = { width: number; height: number; data: Uint8Array };

/** Parses a binary PPM (P6) or PGM (P5) with maxval 255, as grim writes them, into grayscale. */
export function parsePnm(buf: Buffer): Gray {
  // Header: magic, width, height, maxval, separated by whitespace (and `#` comments), then one whitespace byte.
  let pos = 0;
  const token = () => {
    for (;;) {
      while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]!))) pos++;
      if (buf[pos] !== 0x23) break; // '#'
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    return buf.toString("latin1", start, pos);
  };
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const maxval = Number(token());
  pos++;
  const channels = magic === "P6" ? 3 : magic === "P5" ? 1 : 0;
  if (!channels || maxval !== 255 || !(width > 0 && height > 0) || buf.length < pos + width * height * channels) {
    throw new Error(`Unsupported image (${magic} ${width}x${height} maxval ${maxval}).`);
  }
  const data = new Uint8Array(width * height);
  if (channels === 1) data.set(buf.subarray(pos, pos + data.length));
  else {
    for (let i = 0, p = pos; i < data.length; i++, p += 3) {
      data[i] = (buf[p]! * 299 + buf[p + 1]! * 587 + buf[p + 2]! * 114 + 500) / 1000; // Rec. 601 luma
    }
  }
  return { width, height, data };
}

export const toPgm = (img: Gray) => Buffer.concat([Buffer.from(`P5\n${img.width} ${img.height}\n255\n`), img.data]);

/** Otsu's threshold: the gray level that best splits the histogram into two classes. */
export function otsu(img: Gray): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of img.data) hist[v]!++;
  const total = img.data.length;
  const sumAll = hist.reduce((s, n, v) => s + n * v, 0);
  let best = 0;
  let bestVar = -1;
  let wB = 0;
  let sumB = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0 || wB === total) continue;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / (total - wB);
    const v = wB * (total - wB) * (mB - mF) ** 2;
    if (v > bestVar) {
      bestVar = v;
      best = t;
    }
  }
  return best;
}

/**
 * Makes text dark on a light background (tesseract's models are trained on
 * that), judging by which side of the threshold most pixels fall: the
 * background. Returns whether it inverted.
 */
export function darkOnLight(img: Gray): boolean {
  const t = otsu(img);
  let dark = 0;
  for (const v of img.data) if (v <= t) dark++;
  if (dark <= img.data.length / 2) return false;
  for (let i = 0; i < img.data.length; i++) img.data[i] = 255 - img.data[i]!;
  return true;
}

type Comp = { area: number; x0: number; y0: number; x1: number; y1: number; border: boolean };

/** Connected components of `mask` (8-connected when `diagonal`). Labels start at 1; 0 is outside the mask. */
function label(mask: Uint8Array, width: number, height: number, diagonal: boolean) {
  const labels = new Int32Array(mask.length);
  const stack = new Int32Array(mask.length);
  const comps: Comp[] = [{ area: 0, x0: 0, y0: 0, x1: 0, y1: 0, border: false }];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = comps.length;
    const c: Comp = { area: 0, x0: width, y0: height, x1: -1, y1: -1, border: false };
    comps.push(c);
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    while (top) {
      const i = stack[--top]!;
      const x = i % width;
      const y = (i - x) / width;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) c.border = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (mask[j] && !labels[j]) {
            labels[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
  }
  return { labels, comps };
}

/**
 * Paints over what misleads tesseract, in an image of dark text on light:
 *
 * - Ruling lines (table grids, TUI frames, rules): a component much larger than
 *   the text that is sparse or thin. Left in, a grid made tesseract drop a
 *   table's cells when reading it as one block.
 * - Slashes in zeros (Iosevka, foot's font here, and most coding fonts), which
 *   tesseract reads as `@`, `8` or `B`. A glyph-sized component with one hole
 *   above another and both outer sides unbroken between them is a slashed zero
 *   (`8` and `B` pinch at the waist, `@` nests its holes); everything between
 *   its sides goes.
 *
 * Returns how many of each it painted over, and whether a grid (a ruled table
 * or frame) was among the rules.
 */
export function cleanForOcr(img: Gray): { grid: boolean; rules: number; zeros: number } {
  const { width, height, data } = img;
  const t = otsu(img);
  const fgMask = new Uint8Array(data.length);
  const bgMask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) (data[i]! <= t ? fgMask : bgMask)[i] = 1;
  const fg = label(fgMask, width, height, true);
  const bg = label(bgMask, width, height, false);

  // Glyph scale: the median height of foreground components that look like characters.
  const heights = fg.comps
    .slice(1)
    .filter((c) => c.area >= 4)
    .map((c) => c.y1 - c.y0 + 1)
    .sort((a, b) => a - b);
  const glyph = heights[heights.length >> 1] ?? 0;
  if (!glyph) return { grid: false, rules: 0, zeros: 0 };
  const glyphSized = (c: Comp) => c.y1 - c.y0 + 1 <= glyph * 2.5 && c.x1 - c.x0 + 1 <= glyph * 2.5;
  const clear = new Uint8Array(data.length); // pixels to paint as background

  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) if (bgMask[i]) hist[data[i]!]!++;
  const paper = hist.indexOf(Math.max(...hist)); // the commonest background level

  // Rules: at least 3 glyphs long, and under 15% filled (a grid) or at most a quarter glyph thick (a
  // line). Grids are often lighter than text, so here ink is anything clearly darker than the paper.
  const inkMask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) inkMask[i] = data[i]! < paper - 40 ? 1 : 0;
  const ink = label(inkMask, width, height, true);
  const rule = new Uint8Array(ink.comps.length);
  let rules = 0;
  let grid = false;
  ink.comps.forEach((c, id) => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    const sparse = c.area < w * h * 0.15;
    if (id && Math.max(w, h) >= glyph * 3 && (sparse || Math.min(w, h) <= Math.max(2, glyph / 4))) {
      rule[id] = 1;
      rules++;
      if (sparse && Math.min(w, h) >= glyph * 3) grid = true;
    }
  });
  if (rules) {
    // With their antialiased fringe, which isn't dark enough to be ink.
    for (let i = 0; i < data.length; i++) {
      if (!rule[ink.labels[i]!]) continue;
      const x = i % width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * width + dx;
          if (x + dx >= 0 && x + dx < width && j >= 0 && j < data.length && !(inkMask[j] && !rule[ink.labels[j]!])) clear[j] = 1;
        }
      }
    }
  }

  // Each hole (background not reaching the edge) belongs to the component around it: the
  // pixel above its first pixel in raster order is foreground, and part of that component.
  const holesOf = new Map<number, number[]>();
  const seen = new Set<number>();
  for (let i = 0; i < data.length; i++) {
    const h = bg.labels[i]!;
    if (!h || bg.comps[h]!.border || seen.has(h)) continue;
    seen.add(h);
    const owner = fg.labels[i - width]!;
    holesOf.set(owner, [...(holesOf.get(owner) ?? []), h]);
  }

  let zeros = 0;
  for (const [owner, holes] of holesOf) {
    const o = fg.comps[owner]!;
    if (holes.length !== 2 || !glyphSized(o)) continue;
    const [up, down] = holes.map((h) => bg.comps[h]!).sort((p, q) => p.y0 - q.y0) as [Comp, Comp];
    // One hole above the other (`@` nests them), meeting at the slash.
    if (!(up.y1 < down.y1 && down.y0 <= up.y1 + 2)) continue;
    // Both outer sides unbroken from the top hole to the bottom one (`8` and `B` pinch at the waist).
    const edge = Math.max(1, Math.round((o.x1 - o.x0 + 1) * 0.25));
    const runs: [number, number][][] = [];
    for (let y = up.y0; y <= down.y1; y++) {
      const row: [number, number][] = [];
      for (let x = o.x0; x <= o.x1; x++) {
        if (fg.labels[y * width + x] !== owner) continue;
        const last = row.at(-1);
        if (last && last[1] === x - 1) last[1] = x;
        else row.push([x, x]);
      }
      runs.push(row);
    }
    if (!runs.every((r) => r.length && r[0]![0] < o.x0 + edge && r.at(-1)![1] > o.x1 - edge)) continue;
    // The slash: everything between the side strokes, whose width is the narrower outer run's, typically.
    const widths = runs.map((r) => Math.min(r[0]![1] - r[0]![0], r.at(-1)![1] - r.at(-1)![0]) + 1).sort((p, q) => p - q);
    const stroke = widths[widths.length >> 1]!;
    runs.forEach((row, i) => {
      const y = up.y0 + i;
      for (let x = row[0]![0] + stroke; x <= row.at(-1)![1] - stroke; x++) clear[y * width + x] = 1;
    });
    zeros++;
  }
  if (!rules && !zeros) return { grid, rules, zeros };

  for (let i = 0; i < data.length; i++) if (clear[i]) data[i] = Math.max(data[i]!, paper);
  return { grid, rules, zeros };
}

/**
 * Reads `O` as zero where only a digit makes sense: in `0x` hex literals, and
 * beside a digit in a word holding at least two digits (`EO308`, `1O24`).
 * Words like `CO2` keep their letter.
 */
export function digitZeros(text: string): string {
  return text
    .replace(/\b[O0]x([0-9A-FO]{2,})\b/g, (_, hex: string) => `0x${hex.replaceAll("O", "0")}`)
    .replace(/\b[A-Za-z0-9]+\b/g, (word) =>
      (word.match(/\d/g)?.length ?? 0) < 2 ? word : word.replace(/O(?=\d)|(?<=\d)O/g, "0"),
    );
}
