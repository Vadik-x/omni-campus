function IconShell({ children, className = "" }) {
  return (
    <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] ${className}`}>
      {children}
    </span>
  );
}

export function CamerasIcon() {
  return (
    <IconShell>
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-cyan-200" fill="none" aria-hidden="true">
        <rect x="3" y="7" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="9" cy="12.5" r="2.3" stroke="currentColor" strokeWidth="1.7" />
        <path d="M14 9.5h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M14 12.5h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </IconShell>
  );
}

export function PresenceIcon() {
  return (
    <IconShell>
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-blue-200" fill="none" aria-hidden="true">
        <circle cx="12" cy="8" r="3" stroke="currentColor" strokeWidth="1.7" />
        <path d="M6.5 18c1.2-2.7 3.1-4 5.5-4s4.3 1.3 5.5 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M4 18h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" opacity="0.65" />
      </svg>
    </IconShell>
  );
}

export function AlertsIcon() {
  return (
    <IconShell>
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-amber-200" fill="none" aria-hidden="true">
        <path d="M12 4 4.6 18h14.8L12 4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M12 9v4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="12" cy="15.8" r="0.9" fill="currentColor" />
      </svg>
    </IconShell>
  );
}

export function SocketIcon({ connected = true }) {
  const toneClass = connected ? "text-violet-200" : "text-slate-300";

  return (
    <IconShell>
      <svg viewBox="0 0 24 24" className={`h-4 w-4 ${toneClass}`} fill="none" aria-hidden="true">
        <path d="M7 9.2a7.2 7.2 0 0 1 10 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M9.8 12a3.3 3.3 0 0 1 4.4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="12" cy="15.7" r="1.3" fill="currentColor" />
      </svg>
    </IconShell>
  );
}
