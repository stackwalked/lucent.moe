import { join } from "node:path";
import { createServer } from "vite";

// Starting Vite runs Start's route generator, which writes src/routeTree.gen.ts exactly as dev
// and build will; nothing is served.
const root = join(import.meta.dir, "..");
const server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    server: { middlewareMode: true },
    logLevel: "warn",
});
await server.close();
