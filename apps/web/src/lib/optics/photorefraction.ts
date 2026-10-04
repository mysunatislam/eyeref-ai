/**
 * Eccentric photorefraction model (twin of backend/eyeref/optics/photorefraction.py).
 *
 *   defocus relative to camera  D = R + 1/d
 *   crescent width              s = p - e / (d |D|)       (0 inside the dead zone)
 *   dead zone                   -1/d - e/(d p) < R < -1/d + e/(d p)
 *   side                        same side as source when D < 0 (verify on the bench!)
 */

export const CRESCENT_SAME_SIDE_FOR_MYOPIC = true;

export interface EccentricGeometry {
  workingDistanceM: number;
  eccentricityM: number;
  pupilDiameterM: number;
}

export type Side = -1 | 0 | 1;

export function validateGeometry(g: EccentricGeometry): string | null {
  if (g.workingDistanceM < 0.2 || g.workingDistanceM > 5) return "working distance outside 0.2-5 m";
  if (g.eccentricityM < 0.0005 || g.eccentricityM > 0.1) return "eccentricity outside 0.5-100 mm";
  if (g.pupilDiameterM < 0.0015 || g.pupilDiameterM > 0.01) return "pupil diameter outside 1.5-10 mm";
  return null;
}

export const defocusRelativeToCamera = (R: number, d: number) => R + 1 / d;
export const deadZoneHalfwidth = (g: EccentricGeometry) =>
  g.eccentricityM / (g.workingDistanceM * g.pupilDiameterM);

export function deadZoneInterval(g: EccentricGeometry): [number, number] {
  const c = -1 / g.workingDistanceM;
  const h = deadZoneHalfwidth(g);
  return [c - h, c + h];
}

export function crescentSideForDefocus(D: number): Side {
  if (D === 0) return 0;
  const same = CRESCENT_SAME_SIDE_FOR_MYOPIC ? D < 0 : D >= 0;
  return same ? 1 : -1;
}

export function crescentWidthM(R: number, g: EccentricGeometry): { widthM: number; side: Side } {
  const D = defocusRelativeToCamera(R, g.workingDistanceM);
  if (Math.abs(D) < 1e-9) return { widthM: 0, side: 0 };
  const s = g.pupilDiameterM - g.eccentricityM / (g.workingDistanceM * Math.abs(D));
  if (s <= 0) return { widthM: 0, side: 0 };
  return { widthM: Math.min(s, g.pupilDiameterM), side: crescentSideForDefocus(D) };
}

export function invertCrescent(widthM: number, side: Side, g: EccentricGeometry): number | null {
  if (side === 0 || widthM <= 0) return null;
  const gap = Math.max(g.pupilDiameterM - widthM, 1e-5);
  const absD = g.eccentricityM / (g.workingDistanceM * gap);
  const myopicRel = (side === 1) === CRESCENT_SAME_SIDE_FOR_MYOPIC;
  return (myopicRel ? -absD : absD) - 1 / g.workingDistanceM;
}

export interface InversionResult {
  refractionD: number;
  sigmaD: number;
  saturated: boolean;
}

export function invertWithUncertainty(
  widthM: number,
  side: Side,
  g: EccentricGeometry,
  sd: { widthM: number; pupilM: number; distanceM: number; eccentricityM: number },
): InversionResult | null {
  const base = invertCrescent(widthM, side, g);
  if (base === null) return null;
  let v = 0;
  const terms: [keyof typeof sd, number][] = [
    ["widthM", sd.widthM],
    ["pupilM", sd.pupilM],
    ["distanceM", sd.distanceM],
    ["eccentricityM", sd.eccentricityM],
  ];
  for (const [name, s] of terms) {
    if (s <= 0) continue;
    const h = s * 0.25;
    const eval_ = (delta: number) =>
      name === "widthM"
        ? invertCrescent(Math.max(widthM + delta, 1e-6), side, g)
        : invertCrescent(widthM, side, {
            workingDistanceM: g.workingDistanceM + (name === "distanceM" ? delta : 0),
            eccentricityM: g.eccentricityM + (name === "eccentricityM" ? delta : 0),
            pupilDiameterM: g.pupilDiameterM + (name === "pupilM" ? delta : 0),
          });
    const p = eval_(h);
    const m = eval_(-h);
    if (p === null || m === null) continue;
    v += (((p - m) / (2 * h)) * s) ** 2;
  }
  const saturated = widthM >= 0.92 * g.pupilDiameterM;
  return { refractionD: base, sigmaD: saturated ? Math.max(Math.sqrt(v), 2) : Math.sqrt(v), saturated };
}
