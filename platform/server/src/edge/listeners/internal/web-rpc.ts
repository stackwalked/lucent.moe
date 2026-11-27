import { implement } from "@lucent/rpc/mount";
import { type WebContract, webContract } from "@lucent/rpc/web";
import { admissionHandlers } from "./web-admission.ts";
import { auditHandlers } from "./web-audit.ts";
import { authHandlers } from "./web-auth.ts";
import { authorityHandlers } from "./web-authority.ts";
import { catalogHandlers } from "./web-catalog.ts";
import { cloudHandlers } from "./web-cloud.ts";
import { crashesHandlers } from "./web-crashes.ts";
import { deletionHandlers } from "./web-deletion.ts";
import { devicesHandlers } from "./web-devices.ts";
import { discordHandlers } from "./web-discord.ts";
import { downloadHandlers } from "./web-download.ts";
import { factsHandlers } from "./web-facts.ts";
import { healthHandlers } from "./web-health.ts";
import { inboxHandlers } from "./web-inbox.ts";
import { membersHandlers } from "./web-members.ts";
import { moderationHandlers } from "./web-moderation.ts";
import { overridesHandlers } from "./web-overrides.ts";
import { preferencesHandlers } from "./web-preferences.ts";
import { privacyHandlers } from "./web-privacy.ts";
import { productsHandlers } from "./web-products.ts";
import { profileHandlers } from "./web-profile.ts";
import { recordHandlers } from "./web-record.ts";
import { releasesHandlers } from "./web-releases.ts";
import { reviewHandlers } from "./web-review.ts";
import type { WebRpcContext } from "./web-shared.ts";
import { shoutsHandlers } from "./web-shouts.ts";
import { appealsHandlers, resourcesHandlers, ticketsHandlers } from "./web-support.ts";
import { systemHandlers } from "./web-system.ts";
import { updatesHandlers } from "./web-updates.ts";

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
    ...membersHandlers,
    ...moderationHandlers,
    ...profileHandlers,
    ...shoutsHandlers,
    ...overridesHandlers,
    ...reviewHandlers,
    ...crashesHandlers,
    ...updatesHandlers,
    ...ticketsHandlers,
    ...appealsHandlers,
    ...resourcesHandlers,
    ...systemHandlers,
    ...discordHandlers,
    ...admissionHandlers,
    ...deletionHandlers,
    ...recordHandlers,
});
