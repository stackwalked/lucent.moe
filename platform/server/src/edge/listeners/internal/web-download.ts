import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { readLoaderOffer } from "../../../delivery/releases/offer.ts";
import { mapOk, served, type WebRpcContext } from "./web-shared.ts";

export const downloadHandlers = {
    "download.loader": async (ctx, _input, { session }) =>
        served(
            mapOk(
                await readLoaderOffer(ctx.auth.db, { catalog: ctx.catalog, sessionToken: session }),
                (offer) =>
                    offer.state === "ready"
                        ? { state: offer.state, number: offer.number, version: offer.version }
                        : offer,
            ),
        ),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
