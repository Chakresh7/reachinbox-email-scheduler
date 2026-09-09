import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      /**
       * Proxying the API through the dev server is a deliberate auth decision,
       * not a convenience.
       *
       * The session is an httpOnly cookie. If the browser talked to
       * localhost:4000 directly, that cookie would be cross-site and would need
       * `SameSite=None; Secure` — which means HTTPS in development and runs
       * into browser third-party-cookie restrictions. Proxying makes the API
       * same-origin, so a plain `SameSite=Lax` cookie works, exactly as it will
       * in production where both sit behind one origin.
       */
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
      // Health probes and the BullMQ dashboard live outside /api.
      "/healthz": { target: "http://localhost:4000", changeOrigin: true },
      "/readyz": { target: "http://localhost:4000", changeOrigin: true },
      "/admin": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
