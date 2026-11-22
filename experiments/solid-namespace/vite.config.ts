import { resolve } from "node:path";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig(({ isSsrBuild }) => ({
  root: import.meta.dirname,
  plugins: [solid()],
  build: {
    outDir: isSsrBuild ? ".dist/server" : ".dist/client",
    emptyOutDir: true,
    manifest: !isSsrBuild,
    rollupOptions: {
      input: resolve(import.meta.dirname, isSsrBuild ? "entry-server.tsx" : "entry-client.tsx"),
      output: { entryFileNames: isSsrBuild ? "render.js" : "client.js" },
    },
  },
}));
