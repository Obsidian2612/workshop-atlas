import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  preset: "node_server",
  // Serve the Vite build output (dist) and use its HTML shell so the SPA boots.
  // Without this the server only knows about public/ images and falls back to an
  // index.html that points at /src/main.tsx, which does not exist in production.
  renderer: {
    template: "dist/index.html",
  },
  publicAssets: [{ dir: "dist", baseURL: "/", maxAge: 60 * 60 }],
  routeRules: {
    "/api/**": { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  },
});
