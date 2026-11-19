import { rmSync } from "node:fs";
import { loadProductCatalog } from "@lucent/catalog/catalog";
import { systemClock } from "@lucent/core/clock";
import { describeUnknownError, ignoreErrorsSync, invariant, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { systemCryptoRng } from "@lucent/core/rng";
import { createPwnedPasswordsCheck } from "./auth/breach.ts";
import { createAuthDeps } from "./auth/deps.ts";
import { expiredAuthJob } from "./auth/expiry.ts";
import { createArgon2idHasher, type PasswordHasher } from "./auth/password.ts";
import { createTotpKeyring } from "./auth/totp.ts";
import type { ListenAddress, NativeListenAddress, ServerConfig } from "./config.ts";
import type { Logger } from "./core/log.ts";
import { claimServiceEpoch, openEpochGuard } from "./db/epoch-guard.ts";
import type { MigrationError, MigrationFile } from "./db/migrate.ts";
import { verifySchemaCurrent } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";
import { createInternalWebApp } from "./internal/app.ts";
import { type Every, startJobs } from "./jobs/runner.ts";
import { createNativeApp } from "./native/app.ts";
import { nativeExpiryJob } from "./native/expiry.ts";
import { refusalResponse } from "./native/http.ts";
import { createLeaseSigner } from "./native/lease-key.ts";

// How long a superseded instance keeps answering before it notices; the handover window.
const EPOCH_POLL_INTERVAL_MS = 2_000;

export type BootFailure =
    | { readonly code: "SCHEMA_NOT_CURRENT"; readonly detail: string }
    | { readonly code: "DATABASE_UNAVAILABLE"; readonly detail: string }
    | { readonly code: "CATALOG_INVALID"; readonly detail: string }
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
    readonly config: ServerConfig;
    readonly logger: Logger;
    readonly migrations?: readonly MigrationFile[];
    readonly epochPollIntervalMs?: number;
    readonly passwords?: PasswordHasher;
    readonly every?: Every;
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

    const auth = createAuthDeps({
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
    serve = createInternalWebApp({
        auth,
        catalog: catalog.value,
        epochGuard,
        webInternalKey: config.webInternalKey,
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
            isSuperseded: epochGuard.isSuperseded,
            logger,
        }).fetch;
    }
    const jobs = startJobs({
        jobs: [expiredAuthJob(db), ...(nativeDb === null ? [] : [nativeExpiryJob(nativeDb)])],
        logger,
        isSuperseded: epochGuard.isSuperseded,
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
            for (const listener of listeners) await listener.stop();
            await jobs.stop();
            epochGuard.close();
            await nativeDb?.close();
            await db.close();
        },
    });
}
