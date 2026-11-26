import { defineContract } from "./contract.ts";
import { appealsContract } from "./web/appeals.ts";
import { applicationsContract } from "./web/applications.ts";
import { auditContract } from "./web/audit.ts";
import { authContract } from "./web/auth.ts";
import { authorityContract, AccountStatus as Status } from "./web/authority.ts";
import { catalogContract } from "./web/catalog.ts";
import { cloudContract } from "./web/cloud.ts";
import { commentsContract } from "./web/comments.ts";
import { crashesContract } from "./web/crashes.ts";
import { deletionContract } from "./web/deletion.ts";
import { devicesContract } from "./web/devices.ts";
import { discordContract } from "./web/discord.ts";
import { downloadContract } from "./web/download.ts";
import { factsContract } from "./web/facts.ts";
import { guidesContract } from "./web/guides.ts";
import { healthContract } from "./web/health.ts";
import { inboxContract } from "./web/inbox.ts";
import { invitesContract } from "./web/invites.ts";
import { membersContract } from "./web/members.ts";
import { moderationContract } from "./web/moderation.ts";
import { overridesContract } from "./web/overrides.ts";
import { preferencesContract } from "./web/preferences.ts";
import { privacyContract } from "./web/privacy.ts";
import { productsContract } from "./web/products.ts";
import { profileContract } from "./web/profile.ts";
import { recordContract } from "./web/record.ts";
import { releasesContract } from "./web/releases.ts";
import { resourcesContract } from "./web/resources.ts";
import { reviewContract } from "./web/review.ts";
import { searchContract } from "./web/search.ts";
import { shoutsContract } from "./web/shouts.ts";
import { systemContract } from "./web/system.ts";
import { ticketsContract } from "./web/tickets.ts";
import { updatesContract } from "./web/updates.ts";
import { waitlistContract } from "./web/waitlist.ts";

export const AccountStatus = Status;
export type AccountStatus = Status;

// The internal listener's streaming route for the current loader's bytes: a GET with the peer
// key and `Lucent-Session`, answered with the bytes, or a refusal as JSON (401 SESSION_INVALID,
// 404 NOT_FOUND when `download.loader` isn't "ready", 503).
export const LOADER_DOWNLOAD_PATH = "/internal/web/downloads/loader";

// The internal listener's server-sent events: a GET with the peer key and `Lucent-Session`,
// answered with a stream of `presence` ({ online }) and content pings (`shout`, `comment`) that
// carry no content, or a refusal as JSON (401 SESSION_INVALID, 503).
export const COMMUNITY_EVENTS_PATH = "/internal/web/events";

// The internal listener's streaming routes for resource bytes (described in web/resources.ts):
// staff POST the raw bytes to the upload path; a member GETs `<download path>/<resource id>`.
export const RESOURCE_UPLOAD_PATH = "/internal/web/resources/upload";
export const RESOURCE_DOWNLOAD_PATH = "/internal/web/resources/files";

// The internal listener's streaming routes for avatars. Upload: a member POSTs the raw image
// bytes (at most 512 KiB, JPEG, PNG or WebP) with `Lucent-Session`, answered `{ large, small }`
// digests or an AvatarUploadRefusal (web/profile.ts). Images: a GET of `<path>/<digest>` with
// `Lucent-Session`, answered with the WebP while some profile the member may open names it,
// or 404.
export const AVATAR_UPLOAD_PATH = "/internal/web/avatars/upload";
export const AVATAR_IMAGE_PATH = "/internal/web/avatars/images";
// The banner's upload is the avatar's route in every way but what platform stores: one 1500x400
// WebP instead of the two squares. Its image is served by the same digest route.
export const BANNER_UPLOAD_PATH = "/internal/web/banner/upload";

function composeWebContract() {
    return defineContract({
        ...healthContract,
        ...catalogContract,
        ...cloudContract,
        ...authContract,
        ...devicesContract,
        ...productsContract,
        ...downloadContract,
        ...authorityContract,
        ...releasesContract,
        ...factsContract,
        ...auditContract,
        ...inboxContract,
        ...preferencesContract,
        ...privacyContract,
        ...moderationContract,
        ...membersContract,
        ...profileContract,
        ...guidesContract,
        ...commentsContract,
        ...shoutsContract,
        ...searchContract,
        ...overridesContract,
        ...reviewContract,
        ...crashesContract,
        ...updatesContract,
        ...ticketsContract,
        ...appealsContract,
        ...resourcesContract,
        ...systemContract,
        ...discordContract,
        ...invitesContract,
        ...waitlistContract,
        ...applicationsContract,
        ...deletionContract,
        ...recordContract,
    });
}

// A browser importing only AccountStatus need not assemble the server procedure map.
export const webContract = /* @__PURE__ */ composeWebContract();

export type WebContract = typeof webContract;
