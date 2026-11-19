import type { Plugin } from "vite";
import { tokenStylesheet } from "../src/ui/tokens.ts";

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
