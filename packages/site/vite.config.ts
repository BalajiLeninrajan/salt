import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rollupOptions: {
      // The dashboard SPA is the only Vite entry; the marketing page's
      // index.html stays a plain asset in public/ so the Worker's fallthrough
      // serves it untouched.
      input: "app.html",
    },
  },
});
