/** Half-rose histogram of posterior axis samples on the TABO 0–180° semicircle. */
export function AxisPolar({
  samples,
  truth,
  size = 220,
}: {
  samples: number[];
  truth?: number | null;
  size?: number;
}) {
  const bins = 36;
  const h = new Array<number>(bins).fill(0);
  for (const a of samples) h[Math.min(bins - 1, Math.floor((((a % 180) + 180) % 180) / (180 / bins)))]!++;
  const max = Math.max(1, ...h);
  const cx = size / 2;
  const cy = size * 0.62;
  const R = size * 0.45;
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy - Math.sin(a) * r] as const;
  };
  return (
    <svg
      viewBox={`-16 0 ${size + 32} ${size * 0.72}`}
      className="w-full max-w-xs"
      role="img"
      aria-label="Axis posterior"
    >
      {[0.33, 0.66, 1].map((k) => (
        <path
          key={k}
          d={`M ${cx - R * k} ${cy} A ${R * k} ${R * k} 0 0 1 ${cx + R * k} ${cy}`}
          fill="none"
          stroke="var(--line)"
        />
      ))}
      {[0, 45, 90, 135, 180].map((d) => {
        const [x, y] = pt(d, R + 10);
        const [x2, y2] = pt(d, R);
        return (
          <g key={d}>
            <line x1={cx} y1={cy} x2={x2} y2={y2} stroke="var(--line)" strokeDasharray="2 3" />
            <text x={x} y={y + 3} fontSize="9" textAnchor="middle" fill="var(--muted)">
              {d}°
            </text>
          </g>
        );
      })}
      {h.map((v, i) => {
        if (!v) return null;
        const a0 = i * (180 / bins);
        const a1 = a0 + 180 / bins;
        const r = (v / max) * R;
        const [x0, y0] = pt(a0, r);
        const [x1, y1] = pt(a1, r);
        return (
          <path
            key={i}
            d={`M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 0 0 ${x1} ${y1} Z`}
            fill="var(--accent)"
            opacity={0.75}
          />
        );
      })}
      {truth !== null &&
        truth !== undefined &&
        (() => {
          const [x, y] = pt(((truth % 180) + 180) % 180, R);
          return (
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="var(--sim)" strokeWidth="2" strokeDasharray="4 3" />
          );
        })()}
    </svg>
  );
}
