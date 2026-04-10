import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("@vladmandic/face-api") || id.includes("@tensorflow")) {
            return "vendor-face";
          }

          if (id.includes("react-leaflet") || id.includes("leaflet")) {
            return "vendor-map";
          }

          if (id.includes("framer-motion") || id.includes("motion-dom") || id.includes("motion-utils")) {
            return "vendor-motion";
          }

          if (id.includes("react-router") || id.includes("react-dom") || id.includes("react")) {
            return "vendor-react";
          }

          return "vendor-misc";
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
