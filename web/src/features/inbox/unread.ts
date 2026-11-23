import { createServerFn } from "@tanstack/react-start";
import { callPlatform } from "../../server/platform.ts";

// A count isn't required to navigate. Keep the inbox link if the count is unavailable.
export const fetchUnread = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await callPlatform("inbox.unread.count", {}, { whenSignedOut: "return" });
    return reply.ok ? reply.value.count : null;
});
