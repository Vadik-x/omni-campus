import { motion } from "framer-motion";

export default function RouteLoadingScreen() {
  return (
    <div className="min-h-screen bg-[#0B0F14] px-4 py-6 text-slate-100">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_15%_8%,rgba(0,229,255,0.1),transparent_36%),radial-gradient(circle_at_82%_20%,rgba(59,130,246,0.14),transparent_34%)]" />
      <div className="mx-auto max-w-[1200px]">
        <div className="glass-card rounded-2xl p-6">
          <motion.div
            initial={{ opacity: 0.6 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, repeat: Infinity, repeatType: "mirror" }}
            className="space-y-3"
            role="status"
            aria-label="Loading page"
          >
            <div className="h-6 w-56 rounded-lg bg-white/[0.08]" />
            <div className="h-3 w-40 rounded-lg bg-white/[0.06]" />
            <div className="h-[420px] rounded-xl bg-white/[0.05]" />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
