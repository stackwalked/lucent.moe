import { join } from "node:path";
import babel from "@rolldown/plugin-babel";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Plugin order is Start's requirement: its transforms run before React's, and the React Compiler
// last, over what they produced.
export default defineConfig({
    cacheDir: join(import.meta.dirname, "../.moon/cache/vite/web"),
    server: { host: "localhost", port: 4710, strictPort: true },
    build: { sourcemap: "hidden" },
    plugins: [
        tanstackStart(),
        react(),
        babel({
            presets: [
                {
                    preset: () => ({ plugins: [["babel-plugin-react-compiler", {}]] }),
                    rolldown: { filter: { id: /\.[jt]sx?$/ } },
                },
            ],
        }),
    ],
});
