import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The first-load budget: no page makes a browser fetch more than 180 KB of gzipped JavaScript
// before it works. The aim is 150; React, Start, the router and seroval are about 115 KB of it,
// and full zod in the browser 26 KB more (wishlist: zod out of the client). What a page fetches
// first is every script and preload Start's manifest lists along its route branch, root to leaf;
// later navigations fetch less. Fails web:check, naming the pages over it, heaviest first.

const BUDGET_BYTES = 180 * 1024;
const DIST = join(import.meta.dir, "../dist");

const Route = z.object({
    children: z.array(z.string()).optional(),
    preloads: z.array(z.string()).optional(),
    scripts: z.array(z.object({ attrs: z.object({ src: z.string() }) })).optional(),
});
const Manifest = z.object({ routes: z.record(z.string(), Route) });

const assets = join(DIST, "server/assets");
const file = readdirSync(assets).find((name) => name.startsWith("_tanstack-start-manifest"));
if (file === undefined) {
    process.stderr.write("no Start manifest in dist/server/assets: run web:build\n");
    process.exit(1);
}
const loaded: unknown = await import(join(assets, file));
const { routes } = Manifest.parse(
    z.object({ tsrStartManifest: z.function() }).parse(loaded).tsrStartManifest(),
);

const parentOf = new Map<string, string>();
for (const [id, route] of Object.entries(routes)) {
    for (const child of route.children ?? []) parentOf.set(child, id);
}

const gzipped = new Map<string, number>();
async function sizeOf(path: string): Promise<number> {
    const known = gzipped.get(path);
    if (known !== undefined) return known;
    const bytes = new Uint8Array(await Bun.file(join(DIST, "client", path)).arrayBuffer());
    const size = Bun.gzipSync(bytes, { level: 9 }).byteLength;
    gzipped.set(path, size);
    return size;
}

const pages: { readonly id: string; readonly bytes: number }[] = [];
for (const [id, route] of Object.entries(routes)) {
    if ((route.children ?? []).length > 0) continue;
    const scripts = new Set<string>();
    for (let at: string | undefined = id; at !== undefined; at = parentOf.get(at)) {
        const step = routes[at];
        for (const path of step?.preloads ?? []) scripts.add(path);
        for (const script of step?.scripts ?? []) scripts.add(script.attrs.src);
    }
    let bytes = 0;
    for (const path of scripts) bytes += await sizeOf(path);
    pages.push({ id, bytes });
}
pages.sort((a, b) => b.bytes - a.bytes);

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const over = pages.filter((page) => page.bytes > BUDGET_BYTES);
for (const page of over) {
    process.stderr.write(`${page.id}: ${kb(page.bytes)} gzipped, over ${kb(BUDGET_BYTES)}\n`);
}
const heaviest = pages[0];
process.stdout.write(
    `${pages.length} pages; heaviest ${heaviest?.id ?? "none"} at ${kb(heaviest?.bytes ?? 0)} of ${kb(BUDGET_BYTES)}\n`,
);
if (over.length > 0) process.exit(1);
