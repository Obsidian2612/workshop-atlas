import { defineConfig } from "nitro";

export default defineConfig({
  serverDir: "./server",
  preset: "node_server",
  routeRules: {
    "/api/**": { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  },
});
