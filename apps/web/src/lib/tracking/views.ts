/**
 * Which part of the camera frame the face tracker looks at. Its face detector shrinks the whole frame to a small
 * square, so a face a metre from a phone's main camera (about a tenth of a 1080p frame's long side) is too small
 * for it to find. It finds faces about a fifth as wide as the square it is given (a third or more is too big):
 * a square crop around where the face is likely to be gives it that. Landmarks found in a crop are mapped back
 * to the full frame, so measurements still read the raw frame.
 */

/** A part of the frame, in the frame's pixels; `bright` lifts it for a dim room. */
export interface TrackView {
  x: number;
  y: number;
  w: number;
  h: number;
  bright: boolean;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the centre crops tried, as shares of the frame's short side: a face 1-1.5 m away is a fifth of either */
export const CENTRE_SHARES = [1, 0.75] as const;
/** how many face widths a crop around the last-seen face spans */
export const FACE_WIDTHS = 5;

export const fullView = (W: number, H: number, bright = false): TrackView => ({
  x: 0,
  y: 0,
  w: W,
  h: H,
  bright,
});

export const isFull = (v: TrackView, W: number, H: number) =>
  v.x === 0 && v.y === 0 && v.w === W && v.h === H;

function square(cx: number, cy: number, side: number, W: number, H: number, bright: boolean): TrackView {
  const s = Math.round(Math.min(side, W, H));
  const x = Math.round(Math.min(Math.max(cx - s / 2, 0), W - s));
  const y = Math.round(Math.min(Math.max(cy - s / 2, 0), H - s));
  return { x, y, w: s, h: s, bright };
}

/** A square `share` of the short side across, in the middle of the frame, where the face is when the phone is
 * held at eye height and pointed at it. */
export const centreView = (W: number, H: number, bright = false, share: number = CENTRE_SHARES[0]) =>
  square(W / 2, H / 2, share * Math.min(W, H), W, H, bright);

/** A square of FACE_WIDTHS face widths around `box`, or null when the face is big enough in the whole frame. */
export function viewAround(box: Box, W: number, H: number, bright = false): TrackView | null {
  const m = Math.min(W, H);
  const side = Math.max(FACE_WIDTHS * Math.max(box.w, box.h), 0.3 * m);
  if (side > m) return null;
  return square(box.x + box.w / 2, box.y + box.h / 2, side, W, H, bright);
}

/**
 * The views to try, one per frame, while the face is lost: around where it was last seen, the centre crops, then
 * the whole frame (for a face close to the phone), first at the brightness that last found it, then the other.
 */
export function searchViews(W: number, H: number, lastBox: Box | null, bright: boolean): TrackView[] {
  const out: TrackView[] = [];
  for (const b of [bright, !bright]) {
    const around = lastBox ? viewAround(lastBox, W, H, b) : null;
    if (around) out.push(around);
    for (const share of CENTRE_SHARES) out.push(centreView(W, H, b, share));
    out.push(fullView(W, H, b));
  }
  return out;
}

/** A landmark found in `view` (0..1 across the view), as 0..1 across the whole W x H frame. */
export const toFrame = (p: { x: number; y: number }, view: TrackView, W: number, H: number) => ({
  x: (view.x + p.x * view.w) / W,
  y: (view.y + p.y * view.h) / H,
});

/** Whether `view` still lies inside a W x H frame (the stream's size can change when the phone turns). */
export const fits = (v: TrackView, W: number, H: number) => v.x + v.w <= W && v.y + v.h <= H;
