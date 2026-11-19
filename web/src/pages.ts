import { routeTree } from "./routeTree.gen.ts";

// Every page path in the route tree, as the router spells them ("$param" segments), for checking
// returnTo against what exists.
type Node = { readonly fullPath?: unknown; readonly children?: unknown };

function walk(node: Node): string[] {
    const own = typeof node.fullPath === "string" ? [node.fullPath] : [];
    const children = node.children;
    const list: readonly Node[] = Array.isArray(children)
        ? children
        : typeof children === "object" && children !== null
          ? Object.values(children)
          : [];
    return [...own, ...list.flatMap(walk)];
}

// Built on first use: the routes import modules that import this one, so the tree isn't
// complete while modules are still loading.
let paths: readonly string[] | null = null;

export function pagePaths(): readonly string[] {
    paths ??= [...new Set(walk(routeTree))].map((path) =>
        path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path,
    );
    return paths;
}
