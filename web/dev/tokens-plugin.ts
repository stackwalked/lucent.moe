import { join } from "node:path";
import { normalizePath, type Plugin } from "vite";
import { LAYER_ORDER, tokenStylesheet } from "../src/ui/tokens.ts";

// Serves the tokens layer as the CSS module `virtual:lucent/tokens.css`, written from
// src/ui/tokens.ts. Vite bundles its config with what it imports and restarts dev when any of it
// changes, so a token edit shows up without anything else watching.
const ID = "virtual:lucent/tokens.css";
const RESOLVED = `\0${ID}`;

export function tokensPlugin(): Plugin {
    return {
        name: "lucent-tokens",
        resolveId: (id) => (id === ID ? RESOLVED : null),
        load: (id) => (id === RESOLVED ? tokenStylesheet() : null),
    };
}

const SRC = `${normalizePath(join(import.meta.dirname, "../src"))}/`;

// A stylesheet's source, not `?url` or `?raw`, which arrive here as JavaScript.
function isStylesheet(id: string): boolean {
    const [path = "", query = ""] = id.split("?");
    return path.startsWith(SRC) && path.endsWith(".css") && !/\b(url|raw)\b/.test(query);
}

// Every stylesheet opens with the whole layer order. The first stylesheet a page loads fixes the
// order of the layers it names, and which one that is isn't ours to choose: a built page links a
// chunk's shared CSS ahead of the entry's (Icon's and Dialog's before global.css, build of
// 2026-11-18), and a module naming only `components` first ranks it below reset, whose
// `* { margin: 0 }` then beats every component.
export function layerOrderPlugin(): Plugin {
    return {
        name: "lucent-layer-order",
        enforce: "pre",
        transform: (code, id) =>
            isStylesheet(id) ? { code: `${LAYER_ORDER}\n${code}`, map: null } : null,
    };
}
