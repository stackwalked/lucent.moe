import { implement } from "@lucent/rpc/mount";
import { type WebContract, webContract } from "@lucent/rpc/web";
import { auditHandlers } from "./web-audit.ts";
import { authHandlers } from "./web-auth.ts";
import { authorityHandlers } from "./web-authority.ts";
import { catalogHandlers } from "./web-catalog.ts";
<<<<<<< HEAD
import { cloudHandlers } from "./web-cloud.ts";
=======
import { commentsHandlers } from "./web-comments.ts";
>>>>>>> 0d15ea4 (server/community: add profiles, comments, shouts and guides)
import { devicesHandlers } from "./web-devices.ts";
import { downloadHandlers } from "./web-download.ts";
import { factsHandlers } from "./web-facts.ts";
import { guidesHandlers } from "./web-guides.ts";
import { healthHandlers } from "./web-health.ts";
import { inboxHandlers } from "./web-inbox.ts";
import { moderationHandlers } from "./web-moderation.ts";
import { preferencesHandlers } from "./web-preferences.ts";
import { privacyHandlers } from "./web-privacy.ts";
import { productsHandlers } from "./web-products.ts";
import { profileHandlers } from "./web-profile.ts";
import { releasesHandlers } from "./web-releases.ts";
import { searchHandlers } from "./web-search.ts";
import type { WebRpcContext } from "./web-shared.ts";
import { shoutsHandlers } from "./web-shouts.ts";

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
    ...privacyHandlers,
    ...moderationHandlers,
    ...profileHandlers,
    ...guidesHandlers,
    ...commentsHandlers,
    ...shoutsHandlers,
    ...searchHandlers,
});
