import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${process.env.NIGHTCREW_PORT ?? 3721}` },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
