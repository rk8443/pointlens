import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// When packaging for Tauri we don't go through the Replit artifact proxy,
// so PORT / BASE_PATH aren't injected. Use Tauri-friendly defaults instead.
const isTauri = process.env.TAURI_BUILD === "1" || !!process.env.TAURI_PLATFORM;

const rawPort = process.env.PORT ?? (isTauri ? "1420" : undefined);

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Tauri loads bundled assets from a tauri://localhost/ origin and needs
// relative URLs so they resolve correctly from any path.
const basePath = process.env.BASE_PATH ?? (isTauri ? "./" : undefined);

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    // Replit's runtime-error overlay tries to wire itself into a parent
    // window message bus that doesn't exist inside a Tauri WebView, which
    // can present as a blank black window on first paint. Only enable it
    // for browser dev builds (NOT desktop builds, NOT production).
    ...(!isTauri && process.env.NODE_ENV !== "production"
      ? [runtimeErrorOverlay()]
      : []),
    ...(!isTauri &&
    process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom", "three"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    watch: {
      usePolling: true,
      interval: 600,
      ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.local/**", "**/src-tauri/**"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
