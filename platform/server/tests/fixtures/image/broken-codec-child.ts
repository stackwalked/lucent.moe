import { runAvatarChild, WASM_FILES } from "../../../src/adapters/image/transcode.ts";

// The real decoder child with its PNG codec swapped for a file that isn't WebAssembly, as a bad
// install or a corrupted package would leave it.
await runAvatarChild({
    ...WASM_FILES,
    png: new URL("never-answers.ts", import.meta.url).href,
});
