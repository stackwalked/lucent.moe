import { rmSync } from "node:fs";
import { loadProductCatalog } from "@lucent/catalog/catalog";
import { describeUnknownError, ignoreErrorsSync, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { systemCryptoRng } from "@lucent/core/rng";
import { createAuthDeps } from "./auth/deps.ts";
import { createArgon2idHasher, type PasswordHasher } from "./auth/password.ts";
import { createTotpKeyring } from "./auth/totp.ts";
import type { ListenAddress, ServerConfig } from "./config.ts";
import type { Logger } from "./core/log.ts";
import { claimServiceEpoch, openEpochGuard } from "./db/epoch-guard.ts";
import type { MigrationError, MigrationFile } from "./db/migrate.ts";
import { verifySchemaCurrent } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";
import { createInternalWebApp } from "./internal/app.ts";

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

function listen(
    address: ListenAddress,
    fetch: (req: Request) => Response | Promise<Response>,
): Result<{ readonly stop: () => Promise<void>; readonly address: string }, BootFailure> {
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
            const host = address.hostname === "::1" ? "[::1]" : address.hostname;
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
}): Promise<Result<RunningServer, BootFailure>> {
    const { config, logger } = params;
    const db = openPool({
        databaseUrl: config.databaseUrl,
        statementTimeoutMs: 5_000,
        applicationName: "platform-server/internal",
    });
    const fail = async (failure: BootFailure): Promise<Result<RunningServer, BootFailure>> => {
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

    // Claimed last before listening: from here on any older instance stops answering.
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
    });
    if (config.passwordOnly) {
        logger.write("warn", "password-only sign-in", {
            origin: "boot",
            detail: "LUCENT_DEV_PASSWORD_ONLY: no second factor, no step-up",
        });
    }
    const app = createInternalWebApp({
        auth,
        catalog: catalog.value,
        epochGuard,
        webInternalKey: config.webInternalKey,
        logger,
    });
    const listening = listen(config.internalListen, app.fetch);
    if (!listening.ok) {
        epochGuard.close();
        return await fail(listening.error);
    }
    const { address } = listening.value;
    logger.write("info", "listening", {
        origin: "boot",
        detail: `${address} epoch ${epoch.value} schema ${schema.value}`,
    });

    return ok({
        internalAddress: address,
        stop: async () => {
            await listening.value.stop();
            epochGuard.close();
            await db.close();
        },
    });
}
