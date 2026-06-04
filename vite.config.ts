import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false,
  },
});
