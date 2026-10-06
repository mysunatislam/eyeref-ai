import type { Facing } from "@/lib/camera/useCamera";

/**
 * The step's rotation (the photorefraction meridian) and the measured one, drawn the way the phone
 * turns as you look at its screen: anticlockwise for the rear camera, and clockwise for the front
 * camera, which faces the other way. The phone is drawn from the screen side, turned to the step.
 */
export function MeridianDial({
  target,
  measured,
  facing = "environment",
  size = 120,
}: {
  target: number;
  measured: number | null;
  facing?: Facing;
  size?: number;
}) {
  const c = size / 2;
  const r = c - 8;
  // a meridian repeats every 180°, so the phone is drawn the short way round: 135° is 45° the other way
  const turn = target > 90 ? target - 180 : target;
  // the SVG's y axis points down, so a positive angle turns clockwise on screen
  const sense = facing === "user" ? 1 : -1;
  const ray = (deg: number, len: number) => {
    const a = (sense * deg * Math.PI) / 180;
    return {
      x1: c - Math.sin(a) * len,
      y1: c + Math.cos(a) * len,
      x2: c + Math.sin(a) * len,
      y2: c - Math.cos(a) * len,
    };
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Target rotation ${target} degrees ${facing === "user" ? "clockwise" : "anticlockwise"}${
        measured === null ? "" : `, now ${Math.round(measured)} degrees`
      }`}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth="1.5" />
      {[0, 45, 90, 135].map((d) => (
        <line key={d} {...ray(d, r)} stroke="var(--line)" strokeWidth="1" strokeDasharray="2 3" />
      ))}
      <line {...ray(target, r - 4)} stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
      {measured !== null && (
        <line {...ray(measured, r - 14)} stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" />
      )}
      <g transform={`rotate(${sense * turn} ${c} ${c})`}>
        <rect
          x={c - 9}
          y={c - 16}
          width="18"
          height="32"
          rx="4"
          fill="var(--surface)"
          stroke="var(--ink-2)"
          strokeWidth="1.5"
        />
        <rect x={c - 6} y={c - 12} width="12" height="23" rx="1.5" fill="var(--accent-soft)" />
        <line x1={c - 2.5} y1={c - 14} x2={c + 2.5} y2={c - 14} stroke="var(--ink-2)" strokeWidth="1" />
      </g>
      <text x={c} y={size - 2} textAnchor="middle" fontSize="10" fill="var(--muted)">
        {target}°
      </text>
    </svg>
  );
}
