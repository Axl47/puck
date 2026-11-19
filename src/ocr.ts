// Image preparation for OCR, without an image library: grim writes PPM, this
// turns it into a grayscale PGM that tesseract reads. Measured on captures from
// this machine (see DESIGN.md, "OCR").

/** An 8-bit grayscale image, row-major. */
export type Gray = { width: number; height: number; data: Uint8Array };

/** A decoded PNM: `channels` bytes per pixel (1 gray, 3 RGB), row-major. */
export type Pnm = { width: number; height: number; channels: 1 | 3; data: Uint8Array };

/** Parses a binary PPM (P6) or PGM (P5) with maxval 255, as grim writes them. */
export function parsePnm(buf: Buffer): Pnm {
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
  return { width, height, channels, data: new Uint8Array(buf.subarray(pos, pos + width * height * channels)) };
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

type Comp = { area: number; x0: number; y0: number; x1: number; y1: number; border: boolean };

/**
 * Connected components (8-connected when `diagonal`): pixel `j` joins the
 * component started at pixel `seed` when `joins(seed, j)`, and starts one when
 * `joins(j, j)`. Labels start at 1; 0 is outside every component.
 */
function label(width: number, height: number, diagonal: boolean, joins: (seed: number, j: number) => boolean) {
  const size = width * height;
  const labels = new Int32Array(size);
  const stack = new Int32Array(size);
  const comps: Comp[] = [{ area: 0, x0: 0, y0: 0, x1: 0, y1: 0, border: false }];
  for (let start = 0; start < size; start++) {
    if (labels[start] || !joins(start, start)) continue;
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
          if (!labels[j] && joins(start, j)) {
            labels[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
  }
  return { labels, comps };
}

/** Glyph scale: the median height of components that look like characters (0 when there are none). */
function glyphHeight(comps: Comp[]): number {
  const heights = comps
    .slice(1)
    .filter((c) => c.area >= 4)
    .map((c) => c.y1 - c.y0 + 1)
    .sort((a, b) => a - b);
  return heights[heights.length >> 1] ?? 0;
}

/** Chebyshev distance between the colour of pixel `i` and `colour`: the largest difference in any channel. */
function distance(img: Pnm, i: number, colour: readonly number[]): number {
  let d = 0;
  for (let k = 0, p = i * img.channels; k < img.channels; k++, p++) d = Math.max(d, Math.abs(img.data[p]! - colour[k]!));
  return d;
}

/** The commonest colour, to 4 bits a channel, as the mean of the pixels in that bin. */
function dominant(img: Pnm): number[] {
  const { channels: ch, data } = img;
  const size = img.width * img.height;
  const bin = (i: number) => {
    let key = 0;
    for (let k = 0; k < ch; k++) key = (key << 4) | (data[i * ch + k]! >> 4);
    return key;
  };
  const counts = new Uint32Array(1 << (4 * ch));
  for (let i = 0; i < size; i++) counts[bin(i)]!++;
  const best = counts.indexOf(Math.max(...counts));
  const sum = new Array<number>(ch).fill(0);
  for (let i = 0; i < size; i++) if (bin(i) === best) for (let k = 0; k < ch; k++) sum[k]! += data[i * ch + k]!;
  return sum.map((v) => v / counts[best]!);
}

/**
 * Morphological closing of a w×h mask with a (2r+1)-square: fills every gap
 * the square can't fit into. Beyond the mask's edges counts as unset when
 * growing and set when shrinking, so shapes touching the edge keep it.
 */
function close(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // One pass along rows or columns: grow sets a pixel if any within r is set, shrink if all are.
  const pass = (src: Uint8Array, grow: boolean, rows: boolean) => {
    const out = new Uint8Array(src.length);
    const [n, len, step] = rows ? [h, w, 1] : [w, h, w];
    for (let line = 0; line < n; line++) {
      const base = rows ? line * w : line;
      let set = 0; // set pixels in the window [k - r, k + r], clipped to the line
      for (let j = 0; j < Math.min(r, len); j++) set += src[base + j * step]!;
      for (let k = 0; k < len; k++) {
        if (k + r < len) set += src[base + (k + r) * step]!;
        if (k - r - 1 >= 0) set -= src[base + (k - r - 1) * step]!;
        const total = Math.min(len - 1, k + r) - Math.max(0, k - r) + 1;
        out[base + k * step] = (grow ? set > 0 : set === total) ? 1 : 0;
      }
    }
    return out;
  };
  return pass(pass(pass(pass(mask, true, true), true, false), false, true), false, false);
}

/**
 * Turns a capture into dark text on white, whatever the colours: each pixel's
 * darkness is its distance from the background colour (the commonest one),
 * so red or blue text on a dark theme becomes as dark as white text does.
 * Thresholding luma instead dropped foot's red (luma 113 on a background of
 * 37) from a fullscreen terminal, where the threshold rose past it.
 *
 * Solid blocks of another colour (a status bar, a selection, inverse video)
 * would come out as dark slabs hiding their text, so inside each one the
 * distance is taken from the block's own colour instead. Returns the image and
 * how many blocks it found.
 */
export function toInk(img: Pnm): { ink: Gray; blocks: number } {
  const { width, height } = img;
  // Darkness grows twice as fast as the distance, past a floor that absorbs the wallpaper showing
  // through a translucent terminal: the best of the gains and floors tried on the labelled set.
  const gain = 2;
  const floor = 10;
  const data = new Uint8Array(width * height);
  const ink1 = (i: number, colour: readonly number[]) => {
    data[i] = 255 - Math.min(255, Math.round(Math.max(0, distance(img, i, colour) - floor) * gain));
  };
  const paper = dominant(img);
  for (let i = 0; i < data.length; i++) ink1(i, paper);
  const ink = { width, height, data };

  const t = otsu(ink);
  const glyph = glyphHeight(label(width, height, true, (_, j) => data[j]! <= t).comps);
  if (!glyph) return { ink, blocks: 0 };
  // Blocks: regions of one colour, away from the paper's, at least a glyph tall and two wide.
  const same = 24;
  const colours = label(width, height, false, (seed, j) => {
    if (distance(img, j, paper) <= same) return false;
    for (let k = 0, p = seed * img.channels, q = j * img.channels; k < img.channels; k++, p++, q++) {
      if (Math.abs(img.data[p]! - img.data[q]!) > same) return false;
    }
    return true;
  });
  let blocks = 0;
  colours.comps.forEach((c, id) => {
    const w = c.x1 - c.x0 + 1;
    const h = c.y1 - c.y0 + 1;
    // Mostly filled (their text makes the holes), or large enough to be a background (where a selection fills most of a region,
    // the selection is the paper and the terminal's background the block).
    if (!id || h < glyph || w < glyph * 2 || (c.area < w * h * 0.4 && c.area < glyph * glyph * 30)) return;
    // Only its footprint: its pixels and the gaps among them too narrow for a glyph-sized square,
    // which brings the text inside along but not text beside it (a selection wrapping over rows
    // starts and ends mid-row). Its antialiased edge, which would read as a frame, goes white.
    const r = glyph >> 1;
    const x0 = Math.max(0, c.x0 - r - 1);
    const y0 = Math.max(0, c.y0 - r - 1);
    const fw = Math.min(width - 1, c.x1 + r + 1) - x0 + 1;
    const fh = Math.min(height - 1, c.y1 + r + 1) - y0 + 1;
    const own = new Uint8Array(fw * fh);
    const colour = new Array<number>(img.channels).fill(0); // the mean of its pixels
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const i = (y0 + y) * width + x0 + x;
        if (colours.labels[i] !== id) continue;
        own[y * fw + x] = 1;
        for (let k = 0; k < img.channels; k++) colour[k]! += img.data[i * img.channels + k]! / c.area;
      }
    }
    // Closing could grow it out to a nearby image edge, so it stays within its bounding box.
    const foot = close(own, fw, fh, r);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if (x0 + x < c.x0 || x0 + x > c.x1 || y0 + y < c.y0 || y0 + y > c.y1) foot[y * fw + x] = 0;
      }
    }
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        if (!foot[y * fw + x]) continue;
        const gx = x0 + x;
        const gy = y0 + y;
        const atImageEdge = gx === 0 || gy === 0 || gx === width - 1 || gy === height - 1;
        const inside = x > 0 && y > 0 && x < fw - 1 && y < fh - 1 &&
          foot[y * fw + x - 1] && foot[y * fw + x + 1] && foot[(y - 1) * fw + x] && foot[(y + 1) * fw + x];
        if (inside || atImageEdge) ink1(gy * width + gx, colour);
        else data[gy * width + gx] = 255;
      }
    }
    blocks++;
  });
  return { ink, blocks };
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
  const fg = label(width, height, true, (_, j) => fgMask[j] === 1);
  const bg = label(width, height, false, (_, j) => bgMask[j] === 1);

  // Glyph scale: the median height of foreground components that look like characters.
  const glyph = glyphHeight(fg.comps);
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
  const ink = label(width, height, true, (_, j) => inkMask[j] === 1);
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
 * beside a digit in a word of at least two digits and at most one other
 * letter (`EO308`, `1O24`). `CO2` and `ISO8601` keep their letters.
 */
export function digitZeros(text: string): string {
  return text
    .replace(/\b[O0]x([0-9A-FO]{2,})\b/g, (_, hex: string) => `0x${hex.replaceAll("O", "0")}`)
    .replace(/\b[A-Za-z0-9]+\b/g, (word) =>
      (word.match(/\d/g)?.length ?? 0) < 2 || (word.match(/[A-NP-Za-z]/g)?.length ?? 0) > 1
        ? word
        : word.replace(/O(?=\d)|(?<=\d)O/g, "0"),
    );
}
