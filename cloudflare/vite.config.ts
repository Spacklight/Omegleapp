import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL("./spa", import.meta.url));
const src = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Builds the same <OmegleApp /> as a plain single-page app for Cloudflare.
 * (The Termux/Node server renders it through TanStack Start instead.)
 */
export default defineConfig({
  root,
  base: "/",
  resolve: { alias: { "@": src } },
  plugins: [tailwindcss(), viteReact()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
  },
});
