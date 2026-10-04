export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="eyeref-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#eyeref-g)" />
      <path
        d="M5 16c3-5 7-7.5 11-7.5S24 11 27 16c-3 5-7 7.5-11 7.5S8 21 5 16Z"
        fill="none"
        stroke="white"
        strokeWidth="1.8"
      />
      <circle cx="16" cy="16" r="4.2" fill="white" />
      <path d="M16 11.8a4.2 4.2 0 0 1 4.2 4.2h-4.2Z" fill="#c43b2b" opacity="0.9" />
    </svg>
  );
}
