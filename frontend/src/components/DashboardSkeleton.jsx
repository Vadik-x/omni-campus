import { motion } from "framer-motion";

function SkeletonBlock({ className = "" }) {
  return (
    <div
      className={`skeleton-block relative overflow-hidden rounded-xl bg-white/[0.06] ${className}`}
      aria-hidden="true"
    >
      <span className="skeleton-shimmer absolute inset-0" />
    </div>
  );
}

export default function DashboardSkeleton() {
  return (
    <motion.section
      initial={{ opacity: 0.5 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="space-y-4"
      aria-label="Loading dashboard"
      role="status"
    >
      <div className="glass-card rounded-2xl border border-white/10 px-5 py-4">
        <SkeletonBlock className="h-6 w-72 max-w-[80%]" />
        <SkeletonBlock className="mt-2 h-3 w-56 max-w-[65%]" />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={`skeleton-kpi-${index}`} className="glass-card rounded-2xl p-4">
            <SkeletonBlock className="h-4 w-12" />
            <SkeletonBlock className="mt-4 h-3 w-28" />
            <SkeletonBlock className="mt-3 h-8 w-16" />
            <SkeletonBlock className="mt-3 h-3 w-40" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-10">
        <div className="space-y-4 xl:col-span-7">
          <div className="glass-card rounded-2xl p-4">
            <SkeletonBlock className="h-5 w-56" />
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <SkeletonBlock className="h-[220px]" />
              <SkeletonBlock className="h-[220px]" />
            </div>
          </div>

          <div className="glass-card rounded-2xl p-4">
            <SkeletonBlock className="h-5 w-40" />
            <SkeletonBlock className="mt-4 h-[360px]" />
          </div>
        </div>

        <div className="xl:col-span-3">
          <div className="glass-card h-full min-h-[560px] rounded-2xl p-4">
            <SkeletonBlock className="h-5 w-44" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <SkeletonBlock key={`skeleton-feed-${index}`} className="h-[68px]" />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-2xl border border-white/10 p-4">
        <SkeletonBlock className="h-5 w-48" />
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonBlock key={`skeleton-student-${index}`} className="h-[92px]" />
          ))}
        </div>
      </div>
    </motion.section>
  );
}
