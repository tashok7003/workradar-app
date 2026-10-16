const PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  feed: "M4 6h16M4 12h16M4 18h10",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-4.35-4.35",
  snooze: "M12 7v5l3 2M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z",
  check: "M5 12.5 10 17l9-10",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0",
  back: "M15 5l-7 7 7 7",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  alert: "M12 3 2 20h20zM12 10v4M12 17.5v.5",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  x: "M6 6l12 12M18 6 6 18",
  copy: "M9 9h10v10H9zM5 15V5h10",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
  block: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM5.6 5.6l12.8 12.8",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  undo: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};

export function Icon({ name, size = 16, label }: { name: keyof typeof PATHS | string; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      className="icon"
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

/** The WorkRadar mark: a scope with a sweep and two contacts. */
export function RadarMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="radar-mark">
      <circle cx="16" cy="16" r="14" fill="var(--accent)" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="var(--on-accent)" strokeOpacity=".35" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="5" fill="none" stroke="var(--on-accent)" strokeOpacity=".35" strokeWidth="1.2" />
      <path d="M16 16 L16 2 A14 14 0 0 1 28.1 9 Z" fill="var(--on-accent)" fillOpacity=".28" />
      <line x1="16" y1="16" x2="28.1" y2="9" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="22" cy="8.6" r="1.8" fill="var(--on-accent)" />
      <circle cx="10.5" cy="20.5" r="1.4" fill="var(--on-accent)" fillOpacity=".7" />
    </svg>
  );
}
