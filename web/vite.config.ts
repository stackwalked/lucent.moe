import { join } from "node:path";
import babel from "@rolldown/plugin-babel";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { tokensPlugin } from "./dev/tokens-plugin.ts";

const EVERGREEN = ["chrome125", "edge125", "firefox147", "safari26"];

// Plugin order is Start's requirement: its transforms run before React's, and the React Compiler
// last, over what they produced.
export default defineConfig({
    cacheDir: join(import.meta.dirname, "../.moon/cache/vite/web"),
    server: { host: "localhost", port: 4710, strictPort: true },
    // Evergreen browsers only (the web design): the first versions with everything the CSS uses as
    // written (light-dark(), anchor positioning: Firefox 147, January 2026), so nothing is lowered
    // into workarounds.
    build: {
        sourcemap: "hidden",
        target: EVERGREEN,
        cssTarget: EVERGREEN,
    },
    plugins: [
        tokensPlugin(),
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
