import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../../server/outcome.ts";
import { readPlatform } from "../../../server/platform.ts";

// Both halves of the queue at once: the open items to work and the latest closed ones.
export const listReview = createServerFn({ method: "GET" }).handler(async () => {
    const open = await readPlatform("admin.review.list", { state: "open" });
    if (!open.ok) return refuse(open.error);
    const decided = await readPlatform("admin.review.list", { state: "decided" });
    if (!decided.ok) return refuse(decided.error);
    return done({ open: open.value.items, decided: decided.value.items });
});
