import { describe, expect, it } from "vitest";
import { centreView, fits, fullView, searchViews, toFrame, viewAround } from "../tracking/views";

// a portrait 1080p frame; a face a metre from a phone's main camera is about 200 px wide in it, and about 150 px
// at 1.3 m. Chrome's face tracker found those two only in squares about five face widths across.
const W = 1080;
const H = 1920;
const faceAt1m = { x: 300, y: 500, w: 150, h: 180 };

describe("what the face tracker looks at", () => {
  it("crops squares in the middle of the frame, the short side and three quarters of it across", () => {
    const v = centreView(W, H);
    expect([v.w, v.h, v.x]).toEqual([W, W, 0]);
    expect(v.y + v.h / 2).toBeCloseTo(H / 2, 0);
    const q = centreView(W, H, false, 0.75);
    expect(q.w).toBe(810);
    expect(q.x + q.w / 2).toBeCloseTo(W / 2, 0);
  });

  it("crops about five face widths around a small face, kept inside the frame", () => {
    const v = viewAround(faceAt1m, W, H)!;
    expect(v.w).toBe(900);
    expect(fits(v, W, H)).toBe(true);
    expect(v.x).toBe(0); // its square would start left of the frame
    expect(v.y + v.h / 2).toBe(590);
    const edge = viewAround({ x: 950, y: 1850, w: 100, h: 60 }, W, H)!;
    expect(edge.x + edge.w).toBe(W);
    expect(edge.y + edge.h).toBe(H);
  });

  it("uses the whole frame for a face close to the phone", () => {
    expect(viewAround({ x: 200, y: 600, w: 250, h: 300 }, W, H)).toBeNull();
  });

  it("searches around the last-seen face, the centre, then the whole frame, before the other brightness", () => {
    const vs = searchViews(W, H, faceAt1m, false);
    expect(vs).toHaveLength(8);
    expect(vs.slice(0, 4).every((v) => !v.bright)).toBe(true);
    expect(vs.slice(4).every((v) => v.bright)).toBe(true);
    expect(vs.slice(0, 4)).toEqual([
      viewAround(faceAt1m, W, H),
      centreView(W, H),
      centreView(W, H, false, 0.75),
      fullView(W, H),
    ]);
    expect(searchViews(W, H, null, true)).toEqual([
      centreView(W, H, true),
      centreView(W, H, true, 0.75),
      fullView(W, H, true),
      centreView(W, H),
      centreView(W, H, false, 0.75),
      fullView(W, H),
    ]);
  });

  it("maps a landmark found in a crop back onto the whole frame", () => {
    const v = centreView(W, H);
    const p = toFrame({ x: 0.5, y: 0.25 }, v, W, H);
    expect(p.x * W).toBeCloseTo(v.x + 0.5 * v.w, 6);
    expect(p.y * H).toBeCloseTo(v.y + 0.25 * v.h, 6);
    expect(toFrame({ x: 0.3, y: 0.7 }, fullView(W, H), W, H)).toEqual({ x: 0.3, y: 0.7 });
  });

  it("drops a view that no longer fits when the stream turns to landscape", () => {
    expect(fits(viewAround(faceAt1m, W, H)!, W, H)).toBe(true);
    expect(fits({ x: 0, y: 1300, w: 720, h: 720, bright: false }, H, W)).toBe(false);
  });
});
