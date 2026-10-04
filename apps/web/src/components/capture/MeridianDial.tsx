/** Shows the target device rotation (= photorefraction meridian) and the measured one. */
export function MeridianDial({
  target,
  measured,
  size = 120,
}: {
  target: number;
  measured: number | null;
  size?: number;
}) {
  const c = size / 2;
  const r = c - 8;
  const ray = (deg: number, len: number) => {
    const a = (deg * Math.PI) / 180;
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
      aria-label={`Target rotation ${target} degrees`}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth="1.5" />
      {[0, 45, 90, 135].map((d) => (
        <line key={d} {...ray(d, r)} stroke="var(--line)" strokeWidth="1" strokeDasharray="2 3" />
      ))}
      <line {...ray(target, r - 4)} stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
      {measured !== null && (
        <line {...ray(measured, r - 14)} stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" />
      )}
      <g transform={`rotate(${target} ${c} ${c})`}>
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
        <circle cx={c} cy={c - 10} r="2" fill="var(--ink-2)" />
        <circle cx={c} cy={c - 5} r="1.6" fill="var(--warn)" />
      </g>
      <text x={c} y={size - 2} textAnchor="middle" fontSize="10" fill="var(--muted)">
        {target}°
      </text>
    </svg>
  );
}
