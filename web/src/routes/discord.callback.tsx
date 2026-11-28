import { createFileRoute } from "@tanstack/react-router";
import { decideDiscordCallback } from "../features/discord/oauth.ts";
import { patchFlow, readFlow, writeAppliedDiscord } from "../server/cookies.ts";
import { callPlatform } from "../server/platform.ts";

function see(location: string): Response {
    return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

// Where Discord sends the browser back after authorizing. The state kept in the flow cookie ties
// the answer to the browser that asked; it is spent first, so a code can't be replayed here. The
// code goes to platform and never into a page or address the browser keeps.
export const Route = createFileRoute("/discord/callback")({
    server: {
        handlers: {
            GET: async ({ request }) => {
                const query = new URL(request.url).searchParams;
                const decision = decideDiscordCallback(readFlow(), {
                    code: query.get("code"),
                    state: query.get("state"),
                });
                patchFlow({ discordState: null, discordFor: null });
                if (decision.kind === "refuse") {
                    return see(decision.to === "/" ? "/" : `${decision.to}?discord=failed`);
                }
                if (decision.for === "apply") {
                    const claimed = await callPlatform("waitlist.discord.claim", {
                        code: decision.code,
                    });
                    if (!claimed.ok) return see("/apply?discord=failed");
                    writeAppliedDiscord(claimed.value);
                    return see("/apply");
                }
                const linked = await callPlatform(
                    "discord.link.finish",
                    { code: decision.code },
                    { whenSignedOut: "return" },
                );
                if (linked.ok) return see("/account");
                return see(
                    linked.error.code === "ALREADY_LINKED"
                        ? "/account?discord=taken"
                        : "/account?discord=failed",
                );
            },
        },
    },
});
