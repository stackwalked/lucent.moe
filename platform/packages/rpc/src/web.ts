import { defineContract } from "./contract.ts";
import { auditContract } from "./web/audit.ts";
import { authContract } from "./web/auth.ts";
import { authorityContract, AccountStatus as Status } from "./web/authority.ts";
import { catalogContract } from "./web/catalog.ts";
import { cloudContract } from "./web/cloud.ts";
import { devicesContract } from "./web/devices.ts";
import { downloadContract } from "./web/download.ts";
import { factsContract } from "./web/facts.ts";
import { healthContract } from "./web/health.ts";
import { inboxContract } from "./web/inbox.ts";
import { preferencesContract } from "./web/preferences.ts";
import { productsContract } from "./web/products.ts";
import { releasesContract } from "./web/releases.ts";

export const AccountStatus = Status;
export type AccountStatus = Status;

// The internal listener's streaming route for the current loader's bytes: a GET with the peer
// key and `Lucent-Session`, answered with the bytes, or a refusal as JSON (401 SESSION_INVALID,
// 404 NOT_FOUND when `download.loader` isn't "ready", 503).
export const LOADER_DOWNLOAD_PATH = "/internal/web/downloads/loader";

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
    });
}

// A browser importing only AccountStatus need not assemble the server procedure map.
export const webContract = /* @__PURE__ */ composeWebContract();

export type WebContract = typeof webContract;
