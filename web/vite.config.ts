import { join } from "node:path";
import babel from "@rolldown/plugin-babel";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { layerOrderPlugin, tokensPlugin } from "./dev/tokens-plugin.ts";

const EVERGREEN = ["chrome129", "edge129", "firefox147", "safari26"];

// Plugin order is Start's requirement: its transforms run before React's, and the React Compiler
// last, over what they produced.
export default defineConfig({
    cacheDir: join(import.meta.dirname, "../.moon/cache/vite/web"),
    server: { host: "localhost", port: 4710, strictPort: true },
    // Evergreen browsers only (the web design): the first versions with everything used as written,
    // light-dark() and anchor positioning in the CSS (Firefox 147, January 2026) and the WebAuthn
    // JSON parsers in the sign-in pages (Chrome 129), so nothing is lowered or polyfilled.
    build: {
        sourcemap: "hidden",
        target: EVERGREEN,
        cssTarget: EVERGREEN,
    },
    plugins: [
        tokensPlugin(),
        layerOrderPlugin(),
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
