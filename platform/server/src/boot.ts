import { rmSync } from "node:fs";
import { loadProductCatalog } from "@lucent/catalog/catalog";
import { systemClock } from "@lucent/core/clock";
import { describeUnknownError, ignoreErrorsSync, invariant, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { systemCryptoRng } from "@lucent/core/rng";
import { openGeo } from "./adapters/geo/geo.ts";
import { createMailTransport, type MailConfig } from "./adapters/mail/mail.ts";
import { createPwnedPasswordsCheck } from "./auth/breach.ts";
import { createAuthDeps } from "./auth/deps.ts";
import { expiredAuthJob } from "./auth/expiry.ts";
import { createArgon2idHasher, type PasswordHasher } from "./auth/password.ts";
import { createTotpKeyring } from "./auth/totp.ts";
import { CLOUD_LIMITS, type CloudLimits } from "./cloud/items.rules.ts";
import { createEventHub } from "./community/events.ts";
import type { ListenAddress, NativeListenAddress, ServerConfig } from "./config.ts";
import type { Logger } from "./core/log.ts";
import { claimServiceEpoch, openEpochGuard } from "./db/epoch-guard.ts";
import type { MigrationError, MigrationFile } from "./db/migrate.ts";
import { verifySchemaCurrent } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";
import { retentionJob } from "./jobs/retention.ts";
import { type Every, startJobs } from "./jobs/runner.ts";
import { createInternalWebApp } from "./listeners/internal/app.ts";
import { createNativeApp } from "./listeners/native/app.ts";
import { refusalResponse } from "./listeners/native/http.ts";
import { restrictionExpiryJob } from "./moderation/restrictions.ts";
import { mailDeliveryJob } from "./notify/mail.ts";
import { riskScoringJob } from "./risk/scoring.ts";
import { checkCloudLimits } from "./runtime/cloud.ts";
import { nativeExpiryJob } from "./runtime/expiry.ts";
import { createLeaseSigner } from "./runtime/lease-key.ts";
import { geoReloadJob, signInCountriesJob } from "./support/sign-in-countries.ts";
import { idleTicketJob } from "./support/tickets.ts";
import { recordJobRuns } from "./system/jobs.ts";

// How long a superseded instance keeps answering before it notices; the handover window.
const EPOCH_POLL_INTERVAL_MS = 2_000;

export type BootFailure =
    | { readonly code: "SCHEMA_NOT_CURRENT"; readonly detail: string }
    | { readonly code: "DATABASE_UNAVAILABLE"; readonly detail: string }
    | { readonly code: "CATALOG_INVALID"; readonly detail: string }
    | { readonly code: "CLOUD_LIMITS_INVALID"; readonly detail: string }
    | { readonly code: "LISTEN_FAILED"; readonly detail: string };

export type RunningServer = {
    // Where the internal listener answers: an http:// URL, or `unix:<path>`.
    readonly internalAddress: string;
    // Where the loaders' listener answers, likewise; null when the server runs without one.
    readonly nativeAddress: string | null;
    // Stops accepting, lets in-flight requests finish, then releases the database.
    readonly stop: () => Promise<void>;
};

function schemaFailure(error: MigrationError): BootFailure {
    switch (error.code) {
        case "CHECKSUM_MISMATCH":
            return { code: "SCHEMA_NOT_CURRENT", detail: `migration ${error.label} was edited` };
        case "SCHEMA_AHEAD":
            return {
                code: "SCHEMA_NOT_CURRENT",
                detail: `database has migrations this build lacks: ${error.versions.join(", ")}`,
            };
        case "SCHEMA_MISMATCH":
            return {
                code: "SCHEMA_NOT_CURRENT",
                detail: `database is at ${error.current}, this build needs ${error.expected}`,
            };
        default:
            return { code: "DATABASE_UNAVAILABLE", detail: error.code };
    }
}

type Listening = { readonly stop: () => Promise<void>; readonly address: string };

function listen(
    address: ListenAddress | NativeListenAddress,
    fetch: (req: Request) => Response | Promise<Response>,
): Result<Listening, BootFailure> {
    return trySync(
        () => {
            if (address.kind === "unix") {
                // A socket file left by an instance that died is never in use; one held by a live
                // instance is replaced, which is the handover: it keeps its accepted connections.
                ignoreErrorsSync(() => rmSync(address.path, { force: true }));
                const server = Bun.serve({ unix: address.path, fetch });
                return { stop: () => server.stop(), address: `unix:${address.path}` };
            }
            const server = Bun.serve({ hostname: address.hostname, port: address.port, fetch });
            const host = address.hostname.includes(":")
                ? `[${address.hostname}]`
                : address.hostname;
            return { stop: () => server.stop(), address: `http://${host}:${server.port}` };
        },
        (cause) => ({ code: "LISTEN_FAILED" as const, detail: describeUnknownError(cause) }),
    );
}

export async function startServer(params: {
    readonly cloudLimits?: CloudLimits;
    readonly config: ServerConfig;
    readonly logger: Logger;
    readonly migrations?: readonly MigrationFile[];
    readonly epochPollIntervalMs?: number;
    readonly passwords?: PasswordHasher;
    readonly every?: Every;
    readonly mail?: MailConfig;
}): Promise<Result<RunningServer, BootFailure>> {
    const { config, logger } = params;
    const db = openPool({
        databaseUrl: config.databaseUrl,
        statementTimeoutMs: 5_000,
        applicationName: "platform-server/internal",
    });
    // Its own pool, without the browser pool's statement timeout: a loader's request is never
    // queued behind web's, and a lease renewal never times out half-done.
    const nativeDb =
        config.native === null
            ? null
            : openPool({
                  databaseUrl: config.databaseUrl,
                  applicationName: "platform-server/native",
              });
    const listeners: Listening[] = [];
    const fail = async (failure: BootFailure): Promise<Result<RunningServer, BootFailure>> => {
        for (const listener of listeners) await listener.stop();
        await nativeDb?.close();
        await db.close();
        return err(failure);
    };

    const cloudLimits = params.cloudLimits ?? CLOUD_LIMITS;
    const cloudFits = checkCloudLimits(cloudLimits);
    if (!cloudFits.ok) return await fail({ code: "CLOUD_LIMITS_INVALID", detail: cloudFits.error });

    const schema = await verifySchemaCurrent(db, params.migrations);
    if (!schema.ok) return await fail(schemaFailure(schema.error));

    const catalog = loadProductCatalog(config.productsDir);
    if (!catalog.ok) {
        const where = catalog.error.code === "CATALOG_INVALID" ? `${catalog.error.file}: ` : "";
        return await fail({ code: "CATALOG_INVALID", detail: `${where}${catalog.error.detail}` });
    }

    // Bound first, answering "unavailable" until the epoch is claimed: an instance that can't
    // listen (another one holds the port) must not claim it, or the one serving stops answering
    // with nothing to take over. Claiming is what makes any older instance stop.
    let serve: ((req: Request) => Response | Promise<Response>) | null = null;
    const listening = listen(config.internalListen, (req) =>
        serve === null
            ? Response.json(err({ code: "SERVICE_UNAVAILABLE" }), { status: 503 })
            : serve(req),
    );
    if (!listening.ok) return await fail(listening.error);
    listeners.push(listening.value);
    let serveNative: ((req: Request) => Response | Promise<Response>) | null = null;
    if (config.native !== null) {
        const nativeListening = listen(config.native.listen, (req) =>
            serveNative === null
                ? refusalResponse({ code: "SERVICE_UNAVAILABLE" })
                : serveNative(req),
        );
        if (!nativeListening.ok) return await fail(nativeListening.error);
        listeners.push(nativeListening.value);
    }
    const epoch = await claimServiceEpoch(db);
    if (!epoch.ok) return await fail({ code: "DATABASE_UNAVAILABLE", detail: epoch.error.code });
    const epochGuard = openEpochGuard({
        db,
        ownEpoch: epoch.value,
        pollIntervalMs: params.epochPollIntervalMs ?? EPOCH_POLL_INTERVAL_MS,
        onReadFailure: (failure) => {
            logger.write("warn", "epoch read failed", {
                origin: "epoch-guard",
                detail: failure.code,
            });
        },
    });

    const mail = params.mail ?? config.mail;
    const auth = createAuthDeps({
        mailEnabled: mail !== undefined,
        db,
        rng: systemCryptoRng,
        rp: config.relyingParty,
        totpKeys: await createTotpKeyring(config.totpKeys),
        passwords: params.passwords ?? createArgon2idHasher(),
        passwordOnly: config.passwordOnly,
        breachCheck: createPwnedPasswordsCheck({
            baseUrl: config.pwnedPasswordsUrl,
            onUnavailable: (detail) => {
                logger.write("warn", "breach check unavailable", {
                    origin: "breach-check",
                    detail,
                });
            },
        }),
    });
    if (config.passwordOnly) {
        logger.write("warn", "password-only sign-in", {
            origin: "boot",
            detail: "LUCENT_DEV_PASSWORD_ONLY: no second factor, no step-up",
        });
    }
    const events = createEventHub();
    serve = createInternalWebApp({
        events,
        cloudLimits,
        auth,
        catalog: catalog.value,
        epochGuard,
        webInternalKey: config.webInternalKey,
        artifactDir: config.native?.artifactDir ?? null,
        logger,
    }).fetch;
    if (config.native !== null && nativeDb !== null) {
        serveNative = createNativeApp({
            db: nativeDb,
            rng: systemCryptoRng,
            clock: systemClock,
            catalog: catalog.value,
            signer: await createLeaseSigner(config.native.leaseSigningSeed),
            origin: config.native.origin,
            artifactDir: config.native.artifactDir,
            isSuperseded: epochGuard.isSuperseded,
            logger,
            cloudLimits,
        }).fetch;
    }
    // Loaded before the jobs start so the first sign-ins are judged; a file that won't load is
    // logged and tried again by the reload job.
    const geo =
        config.geoCountryFile === undefined ? null : openGeo({ path: config.geoCountryFile });
    const geoLoaded = await geo?.reload();
    if (geoLoaded !== undefined && !geoLoaded.ok) {
        logger.write("warn", "geo unavailable", { origin: "boot", detail: geoLoaded.error.detail });
    }
    const jobs = startJobs({
        jobs: [
            expiredAuthJob(db),
            restrictionExpiryJob(db),
            retentionJob(db),
            riskScoringJob(db),
            idleTicketJob(db),
            signInCountriesJob(db, geo),
            ...(geo === null ? [] : [geoReloadJob(geo)]),
            ...(nativeDb === null ? [] : [nativeExpiryJob(nativeDb)]),
            ...(mail === undefined
                ? []
                : [mailDeliveryJob({ db, mail: await createMailTransport(mail) })]),
        ],
        logger,
        isSuperseded: epochGuard.isSuperseded,
        clock: systemClock,
        record: recordJobRuns(db),
        ...(params.every === undefined ? {} : { every: params.every }),
    });
    const [internal, native] = listeners;
    invariant(internal !== undefined, "the internal listener is bound");
    logger.write("info", "listening", {
        origin: "boot",
        detail: `${internal.address}${native === undefined ? "" : ` and ${native.address}`} epoch ${epoch.value} schema ${schema.value}`,
    });

    return ok({
        internalAddress: internal.address,
        nativeAddress: native?.address ?? null,
        stop: async () => {
            // Open streams never end by themselves, and a listener stop waits for them.
            events.close();
            for (const listener of listeners) await listener.stop();
            await jobs.stop();
            epochGuard.close();
            await nativeDb?.close();
            await db.close();
        },
    });
}
