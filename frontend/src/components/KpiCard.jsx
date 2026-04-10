import { motion } from "framer-motion";
import { kpiCardVariants } from "../lib/motionPresets";

export default function KpiCard({
  icon,
  label,
  value,
  statusText,
  glow = "cyan",
  index = 0,
}) {
  const glowClass =
    glow === "red"
      ? "shadow-[0_0_24px_rgba(248,113,113,0.22)]"
      : glow === "blue"
        ? "shadow-[0_0_24px_rgba(59,130,246,0.22)]"
        : glow === "violet"
          ? "shadow-[0_0_24px_rgba(139,92,246,0.22)]"
          : "shadow-[0_0_24px_rgba(0,229,255,0.24)]";

  return (
    <motion.article
      variants={kpiCardVariants}
      initial="hidden"
      animate="visible"
      custom={index}
      whileHover={{ y: -3, scale: 1.01 }}
      className={`glass-card group min-h-[132px] p-4 transition-all duration-300 hover:border-cyan-300/35 hover:shadow-neon ${glowClass}`}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-base text-cyan-200/90">{icon}</span>
        <span className="rounded-full bg-white/5 px-2 py-1 text-[11px] uppercase tracking-wider text-slate-300">
          KPI
        </span>
      </div>

      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</p>
      <p className="mt-1 text-[2rem] font-extrabold leading-none text-slate-100">{value}</p>
      <p className="mt-2 text-xs font-medium text-cyan-100/80">{statusText}</p>
    </motion.article>
  );
}
