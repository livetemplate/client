/**
 * lineRangeFromBlocks — the HTML preview's region hit-test over block rects the
 * in-iframe bridge posts. Content blocks union; `wrap` blocks (pure page
 * wrappers) only answer when the box hits no content block.
 */
import { lineRangeFromBlocks, PreviewBlock } from "../dom/directives";

const block = (from: number, to: number, top: number, bottom: number, wrap = false): PreviewBlock => ({
  from,
  to,
  left: 0,
  right: 400,
  top,
  bottom,
  ...(wrap ? { wrap: true } : {}),
});

// A page: an outer wrapper (lines 1–40) around a main wrapper (5–30) holding two
// cards with a 40px gap between them.
const blocks: PreviewBlock[] = [
  block(1, 40, 0, 1000, true),
  block(5, 30, 100, 600, true),
  block(8, 9, 120, 200),
  block(20, 22, 240, 320),
];
const box = (top: number, bottom: number) => ({ left: 50, right: 150, top, bottom });

describe("lineRangeFromBlocks", () => {
  it("unions only the content blocks a box touches, never the wrappers around them", () => {
    expect(lineRangeFromBlocks(blocks, box(130, 150), 0, 0)).toEqual({ from: 8, to: 9 });
    expect(lineRangeFromBlocks(blocks, box(150, 260), 0, 0)).toEqual({ from: 8, to: 22 });
  });

  it("falls back to the smallest wrapper when the box hits no content block", () => {
    // the gap between the cards: inside both wrappers, the inner one is smaller
    expect(lineRangeFromBlocks(blocks, box(205, 235), 0, 0)).toEqual({ from: 5, to: 30 });
    // below main, inside only the outer wrapper
    expect(lineRangeFromBlocks(blocks, box(700, 720), 0, 0)).toEqual({ from: 1, to: 40 });
  });

  it("returns null when the box touches nothing", () => {
    expect(lineRangeFromBlocks(blocks, { left: 500, right: 600, top: 10, bottom: 20 }, 0, 0)).toBeNull();
  });

  it("treats blocks without the flag as content (older bridges)", () => {
    const old = blocks.map(({ wrap: _w, ...b }) => b);
    expect(lineRangeFromBlocks(old, box(130, 150), 0, 0)).toEqual({ from: 1, to: 40 });
  });
});
