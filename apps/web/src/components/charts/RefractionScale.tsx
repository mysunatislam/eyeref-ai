import { thresholdsForAge } from "@/lib/optics/classification";
import { formatDiopters } from "@/lib/optics/powerVector";
import type { AgeGroup, EyeResult } from "@/lib/types";

const LO = -8;
const HI = 6;

/**
 * Dioptre number line: screening thresholds, dead zone, CI band and point estimate, or without a number,
 * the range the eye's own refraction lies in once focusing on the light is allowed for.
 */
export function RefractionScale({
  eye,
  ageGroup,
  height = 64,
}: {
  eye: EyeResult;
  ageGroup: AgeGroup;
  height?: number;
}) {
  const W = 400;
  const PAD = 12;
  const x = (d: number) => PAD + ((Math.min(HI, Math.max(LO, d)) - LO) / (HI - LO)) * (W - 2 * PAD);
  const t = thresholdsForAge(ageGroup);
  const y0 = 18;
  const bh = 16;
  const showPoint = eye.outputLevel === "quantitative" && eye.seD !== null;
  const range = showPoint ? null : (eye.refractionRange95 ?? null);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Refraction scale">
      <defs>
        <pattern id="dz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" strokeWidth="1.5" opacity="0.5" />
        </pattern>
      </defs>
      <rect x={PAD} y={y0} width={x(t.myopiaSe) - PAD} height={bh} rx="3" fill="var(--accent-soft)" />
      <rect
        x={x(t.hyperopiaSe)}
        y={y0}
        width={W - PAD - x(t.hyperopiaSe)}
        height={bh}
        rx="3"
        fill="var(--warn-soft)"
      />
      <rect
        x={x(t.myopiaSe)}
        y={y0}
        width={x(t.hyperopiaSe) - x(t.myopiaSe)}
        height={bh}
        fill="var(--ok-soft)"
      />
      {eye.deadZoneD && (
        <rect
          x={x(eye.deadZoneD[0])}
          y={y0 - 4}
          width={x(eye.deadZoneD[1]) - x(eye.deadZoneD[0])}
          height={bh + 8}
          fill="url(#dz)"
          stroke="var(--muted)"
          strokeDasharray="3 2"
          rx="3"
        >
          <title>Dead zone: no crescent is produced in this range</title>
        </rect>
      )}
      {range && (
        <rect
          x={x(range[0])}
          y={y0 + 3}
          width={Math.max(2, x(range[1]) - x(range[0]))}
          height={bh - 6}
          rx="5"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeDasharray="4 2"
        >
          <title>
            {`Where this eye's own refraction lies (95%), allowing for focusing on the light: ${formatDiopters(range[0])} to ${range[1] > HI ? `beyond ${formatDiopters(HI)}` : formatDiopters(range[1])}`}
          </title>
        </rect>
      )}
      {showPoint && eye.seCi95 && (
        <rect
          x={x(eye.seCi95[0])}
          y={y0 + 3}
          width={Math.max(2, x(eye.seCi95[1]) - x(eye.seCi95[0]))}
          height={bh - 6}
          rx="5"
          fill="var(--accent)"
          opacity="0.35"
        />
      )}
      {showPoint && (
        <circle
          cx={x(eye.seD!)}
          cy={y0 + bh / 2}
          r="6"
          fill="var(--accent)"
          stroke="var(--surface)"
          strokeWidth="2"
        />
      )}
      {[-8, -6, -4, -2, 0, 2, 4, 6].map((d) => (
        <g key={d}>
          <line x1={x(d)} x2={x(d)} y1={y0 + bh + 2} y2={y0 + bh + 6} stroke="var(--muted)" />
          <text x={x(d)} y={y0 + bh + 18} textAnchor="middle" fontSize="10" fill="var(--muted)">
            {d > 0 ? `+${d}` : d === 0 ? "0" : `−${Math.abs(d)}`}
          </text>
        </g>
      ))}
      <text x={PAD} y={12} fontSize="10" fill="var(--accent)">
        myopia
      </text>
      <text x={W - PAD} y={12} fontSize="10" textAnchor="end" fill="var(--warn)">
        hyperopia
      </text>
    </svg>
  );
}
