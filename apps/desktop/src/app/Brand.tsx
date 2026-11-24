/** App mark: a beacon tower sweeping light over the harbour. */
export function BeaconMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="beacon-beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFC58A" stopOpacity="0.95" />
          <stop offset="1" stopColor="#FFC58A" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="beacon-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE1BD" />
          <stop offset="1" stopColor="#F08A3A" />
        </linearGradient>
      </defs>
      <path d="M34 19 L60 11 L60 31 Z" fill="url(#beacon-beam)" opacity="0.85" />
      <path d="M30 19 L4 11 L4 31 Z" fill="#FFC58A" opacity="0.18" />
      <rect x="27" y="14" width="10" height="10" rx="3" fill="url(#beacon-body)" />
      <path d="M26 26 H38 L41 52 H23 Z" fill="url(#beacon-body)" opacity="0.92" />
      <path d="M24.5 36 H39.5" stroke="#041016" strokeWidth="2.4" strokeLinecap="round" opacity="0.55" />
      <path d="M10 56 C 20 52, 26 52, 32 56 S 44 60, 54 56" stroke="#7FB6C7" strokeWidth="2.6" fill="none" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}

export function Brand({ waiting }: { waiting: number }) {
  return (
    <div className="flex items-center gap-3 px-5">
      <div className="relative grid size-10 place-items-center rounded-xl bg-gradient-to-br from-harbor-600 to-harbor-950 shadow-[0_8px_20px_-8px_rgba(44,108,128,0.9)] ring-1 ring-beacon-400/30">
        <BeaconMark />
        {waiting > 0 && (
          <span className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-beacon-400 px-1 text-[10px] font-bold text-harbor-950 shadow-[0_0_10px_rgba(255,169,92,0.9)]">
            {waiting}
          </span>
        )}
      </div>
      <div>
        <div className="font-display text-[17px] font-semibold tracking-tight text-ink-50">Session Hub</div>
        <div className="text-[11.5px] text-beacon-300/80">Karanlıkta koşanların feneri</div>
      </div>
    </div>
  );
}
