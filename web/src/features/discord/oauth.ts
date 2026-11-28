import type { FlowState } from "../../server/flow.ts";

export type DiscordPurpose = "apply" | "account";

// Discord's authorize page for the site's application. `state` is checked again on the way back
// against the one kept in the flow cookie, so a code obtained elsewhere can't be made to land
// here.
export function discordAuthorizeUrl(params: {
    readonly clientId: string;
    readonly publicOrigin: string;
    readonly state: string;
}): string {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", params.clientId);
    url.searchParams.set("scope", "identify guilds.join");
    url.searchParams.set("state", params.state);
    url.searchParams.set("redirect_uri", `${params.publicOrigin}/discord/callback`);
    return url.href;
}

export type DiscordCallback =
    | { readonly kind: "finish"; readonly for: DiscordPurpose; readonly code: string }
    | { readonly kind: "refuse"; readonly to: "/apply" | "/account" | "/" };

const PAGES = { apply: "/apply", account: "/account" } as const;

// What to do with the browser Discord sent back: only one that this very browser sent out, for a
// purpose it started. A missing code is the user declining on Discord (`error=access_denied`).
export function decideDiscordCallback(
    flow: Pick<FlowState, "discordState" | "discordFor">,
    query: { readonly code: string | null; readonly state: string | null },
): DiscordCallback {
    if (flow.discordState === undefined || flow.discordFor === undefined) {
        return { kind: "refuse", to: "/" };
    }
    const to = PAGES[flow.discordFor];
    if (query.state !== flow.discordState || query.code === null || query.code === "") {
        return { kind: "refuse", to };
    }
    return { kind: "finish", for: flow.discordFor, code: query.code };
}
