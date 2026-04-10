import { AnimatePresence, motion } from "framer-motion";

const DEFAULT_TOTAL = 5;

const STATE_STYLES = {
  idle: {
    frameBorder: "rgba(0,229,255,0.58)",
    frameGlow: "0 0 30px rgba(0,229,255,0.22), inset 0 0 20px rgba(0,229,255,0.12)",
    accentText: "text-slate-200",
  },
  detecting: {
    frameBorder: "rgba(0,229,255,0.75)",
    frameGlow: "0 0 38px rgba(0,229,255,0.28), inset 0 0 24px rgba(0,229,255,0.2)",
    accentText: "text-cyan-100",
  },
  locked: {
    frameBorder: "rgba(56,189,248,0.92)",
    frameGlow: "0 0 45px rgba(56,189,248,0.34), inset 0 0 28px rgba(56,189,248,0.18)",
    accentText: "text-emerald-200",
  },
  capturing: {
    frameBorder: "rgba(0,229,255,0.95)",
    frameGlow: "0 0 52px rgba(0,229,255,0.36), inset 0 0 30px rgba(0,229,255,0.22)",
    accentText: "text-cyan-100",
  },
  success: {
    frameBorder: "rgba(74,222,128,0.95)",
    frameGlow: "0 0 48px rgba(74,222,128,0.34), inset 0 0 28px rgba(74,222,128,0.24)",
    accentText: "text-emerald-200",
  },
};

function instructionToneClass(instruction = "", state = "idle") {
  if (state === "success") {
    return "text-emerald-200";
  }

  const text = String(instruction || "").toLowerCase();
  if (text.includes("move closer") || text.includes("hold still")) {
    return "text-amber-200";
  }

  if (text.includes("good lighting") || text.includes("face detected")) {
    return "text-emerald-200";
  }

  return "text-slate-200";
}

function normalizedState(value = "idle") {
  if (Object.prototype.hasOwnProperty.call(STATE_STYLES, value)) {
    return value;
  }

  return "idle";
}

export default function FaceCaptureOverlay({
  videoRef,
  showPreview,
  detectionState,
  instruction,
  captureCountdown,
  captureFlash,
  progressCount,
  totalCount = DEFAULT_TOTAL,
}) {
  const state = normalizedState(detectionState);
  const style = STATE_STYLES[state];
  const safeProgress = Math.max(0, Math.min(Number(totalCount), Number(progressCount) || 0));
  const scanActive = state === "detecting" || state === "locked" || state === "capturing";

  return (
    <div className="space-y-4">
      <div className="relative mx-auto max-w-[760px] overflow-hidden rounded-[22px] border border-cyan-300/30 bg-[#050b13] shadow-[0_14px_44px_rgba(0,0,0,0.45)]">
        <div className="pointer-events-none absolute inset-0 z-[1] bg-[radial-gradient(circle_at_18%_20%,rgba(56,189,248,0.2),transparent_44%),radial-gradient(circle_at_80%_80%,rgba(6,182,212,0.2),transparent_45%)]" />
        <div
          className="pointer-events-none absolute inset-0 z-[1] opacity-35"
          style={{
            backgroundImage: "radial-gradient(rgba(148,163,184,0.2) 0.8px, transparent 0.8px)",
            backgroundSize: "14px 14px",
          }}
        />

        {showPreview ? (
          <video
            ref={videoRef}
            className="relative z-[2] h-[320px] w-full bg-[#02060d] object-contain md:h-[420px]"
            playsInline
            muted
            autoPlay
          />
        ) : (
          <div className="relative z-[2] grid h-[320px] place-items-center text-sm text-slate-300 md:h-[420px]">
            Start capture to begin secure biometric scan
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 z-[3] bg-gradient-to-b from-[#020811]/10 via-transparent to-[#020811]/35" />

        <div className="pointer-events-none absolute left-1/2 top-1/2 z-[4] h-[62%] w-[44%] min-h-[180px] min-w-[140px] max-h-[300px] max-w-[260px] -translate-x-1/2 -translate-y-1/2">
          <motion.div
            className="h-full w-full rounded-[50%] border-2"
            animate={{
              scale: state === "locked" ? [1, 1.02, 1] : state === "capturing" ? [1, 1.03, 1] : [1, 1.01, 1],
              borderColor: style.frameBorder,
              boxShadow: style.frameGlow,
            }}
            transition={{
              duration: state === "capturing" ? 1.2 : 2,
              repeat: Number.POSITIVE_INFINITY,
              ease: "easeInOut",
            }}
          />
        </div>

        {scanActive ? (
          <motion.div
            className="pointer-events-none absolute left-[28%] right-[28%] z-[5] h-[2px] rounded-full bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_14px_rgba(0,229,255,0.95)]"
            animate={{ top: ["24%", "76%", "24%"], opacity: [0.35, 0.95, 0.35] }}
            transition={{ duration: 2.8, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
          />
        ) : null}

        <AnimatePresence mode="wait">
          <motion.div
            key={`${state}-${instruction}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="absolute bottom-4 left-1/2 z-[6] -translate-x-1/2 rounded-full border border-white/15 bg-[#081322]/88 px-3 py-1 text-xs"
          >
            <span className={instructionToneClass(instruction, state)}>{instruction}</span>
          </motion.div>
        </AnimatePresence>

        {captureCountdown > 0 && state === "capturing" ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute right-4 top-4 z-[6] rounded-full border border-cyan-300/40 bg-[#081322]/92 px-3 py-1 text-sm font-bold text-cyan-100"
          >
            {captureCountdown}
          </motion.div>
        ) : null}

        <AnimatePresence>
          {state === "success" ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              className="absolute inset-0 z-[6] grid place-items-center"
            >
              <div className="rounded-full border border-emerald-300/50 bg-emerald-500/20 p-3 text-emerald-100 shadow-[0_0_28px_rgba(74,222,128,0.35)]">
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
                  <path d="M5.5 12.5 10 17l8.5-8.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className={`pointer-events-none absolute inset-0 z-[6] bg-white transition-opacity duration-150 ${captureFlash ? "opacity-20" : "opacity-0"}`} />
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Capture Progress</p>
          <p className={`text-xs font-medium ${style.accentText}`}>
            {safeProgress}/{totalCount}
          </p>
        </div>

        <div className="mt-2 flex items-center gap-2">
          {Array.from({ length: totalCount }).map((_, index) => {
            const complete = index < safeProgress;
            const isCurrent = index === safeProgress;

            return (
              <motion.span
                key={`overlay-capture-dot-${index}`}
                className={`h-2.5 w-2.5 rounded-full ${complete ? "bg-cyan-300" : "bg-white/20"}`}
                animate={isCurrent && safeProgress < totalCount ? { scale: [1, 1.22, 1] } : { scale: 1 }}
                transition={isCurrent && safeProgress < totalCount ? { duration: 1.1, repeat: Number.POSITIVE_INFINITY } : { duration: 0.2 }}
              />
            );
          })}
        </div>

        <p className="mt-2 text-xs text-slate-400">Capturing multiple angles improves accuracy</p>
      </div>
    </div>
  );
}
