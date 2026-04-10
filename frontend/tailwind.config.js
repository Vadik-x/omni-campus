/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        sans: ["Manrope", "system-ui", "sans-serif"],
      },
      colors: {
        war: {
          base: "#0B0F14",
          cyan: "#00E5FF",
          blue: "#3B82F6",
          violet: "#8B5CF6",
        },
      },
      boxShadow: {
        neon: "0 0 28px rgba(0,229,255,0.28)",
        "neon-soft": "0 0 18px rgba(59,130,246,0.24)",
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { transform: "scale(1)", opacity: "0.85" },
          "50%": { transform: "scale(1.18)", opacity: "1" },
        },
        scanLine: {
          "0%": { top: "8%", opacity: "0.2" },
          "50%": { opacity: "0.85" },
          "100%": { top: "88%", opacity: "0.2" },
        },
        skeletonShimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        pulseGentle: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.72" },
        },
      },
      animation: {
        "pulse-dot": "pulseDot 1.8s ease-in-out infinite",
        "scan-line": "scanLine 3.2s linear infinite",
        "skeleton-shimmer": "skeletonShimmer 1.6s linear infinite",
        "pulse-gentle": "pulseGentle 2.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
