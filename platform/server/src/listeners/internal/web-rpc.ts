import { implement } from "@lucent/rpc/mount";
import { type WebContract, webContract } from "@lucent/rpc/web";
import { auditHandlers } from "./web-audit.ts";
import { authHandlers } from "./web-auth.ts";
import { authorityHandlers } from "./web-authority.ts";
import { catalogHandlers } from "./web-catalog.ts";
import { cloudHandlers } from "./web-cloud.ts";
import { devicesHandlers } from "./web-devices.ts";
import { downloadHandlers } from "./web-download.ts";
import { factsHandlers } from "./web-facts.ts";
import { healthHandlers } from "./web-health.ts";
import { inboxHandlers } from "./web-inbox.ts";
import { preferencesHandlers } from "./web-preferences.ts";
import { productsHandlers } from "./web-products.ts";
import { releasesHandlers } from "./web-releases.ts";
import type { WebRpcContext } from "./web-shared.ts";

export type { WebRpcContext } from "./web-shared.ts";
export const webProcedures = implement<WebRpcContext, WebContract>(webContract, {
    ...healthHandlers,
    ...catalogHandlers,
    ...cloudHandlers,
    ...authHandlers,
    ...devicesHandlers,
    ...productsHandlers,
    ...downloadHandlers,
    ...authorityHandlers,
    ...releasesHandlers,
    ...factsHandlers,
    ...auditHandlers,
    ...inboxHandlers,
    ...preferencesHandlers,
});
