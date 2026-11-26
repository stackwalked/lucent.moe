import { parseModuleManifest } from "@lucent/bundle/release-manifest";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, toHex } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { type Overrides, toOverridesBytes, toOverridesSignedBytes } from "@lucent/wire/overrides";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { type Forbidden, lockAuthorized, readAsStaff } from "../../identity/authority/staff.ts";
import { findReleaseManifest } from "../releases/reads.ts";
import type { OverrideSigner } from "../runtime/lease-key.ts";
import { bumpDataRevisions } from "../runtime/revisions.ts";
import { decideOverrideChange, type OverrideKind, type OverrideTarget } from "./overrides.rules.ts";

// Kill switches as staff set them, per module release. A change commits the switch, the release's
// next document revision, that revision's override document signed with the override key
// (contracts/overrides/v1), and the data revision of every live session on the release, so their
// next lease says something changed and their next data request (version 3) carries it.

async function signedDocument(
    signer: OverrideSigner,
    fields: Omit<Overrides, "signature">,
): Promise<Uint8Array<ArrayBuffer>> {
    const signature = await signer.sign(toOverridesSignedBytes(fields));
    return toOverridesBytes({ ...fields, signature });
}

// A u64 key as staff read and type it: 16 hex digits.
function toKeyHex(key: bigint): string {
    return key.toString(16).padStart(16, "0");
}

export type ReleaseOverrides = {
    readonly releaseId: string;
    readonly productId: string;
    readonly channel: string;
    // The document revision, 0 before the first switch.
    readonly revision: number;
    readonly features: readonly {
        readonly key: string;
        readonly tag: string;
        readonly off: boolean;
    }[];
    readonly capabilities: readonly {
        readonly key: string;
        readonly level: "optional" | "core";
        readonly off: boolean;
    }[];
    readonly switches: readonly {
        readonly kind: OverrideKind;
        readonly key: string;
        readonly setAt: EpochMs;
        readonly setBy: { readonly id: string; readonly username: string | null };
    }[];
};

const SwitchRow = z.object({
    kind: z.enum(["feature", "capability"]),
    key: z.coerce.bigint(),
    set_at: EpochMs,
    set_by: z.string(),
    username: z.string().nullable(),
});

type NotFound = { readonly code: "NOT_FOUND" };

async function readRelease(q: Queryable, releaseId: Uint8Array) {
    const release = await queryOne(
        q,
        z.object({ product_id: z.string(), channel: z.string() }),
        sql`select product_id, channel from release where id = ${releaseId} and manifest is not null`,
    );
    if (!release.ok) return release;
    if (release.value === null) return ok(null);
    const bytes = await findReleaseManifest(q, releaseId);
    if (!bytes.ok) return bytes;
    invariant(bytes.value !== null, "a module release has a manifest");
    const manifest = parseModuleManifest(bytes.value);
    invariant(manifest.ok, "a stored release manifest was verified when it was published");
    return ok({ ...release.value, manifest: manifest.value });
}

async function readSwitches(q: Queryable, releaseId: Uint8Array) {
    return await queryAll(
        q,
        SwitchRow,
        sql`select o.kind, o.key::text as key, o.set_at, o.set_by, a.username
            from fact_override o join account a on a.id = o.set_by
            where o.release_id = ${releaseId}
            order by o.kind, o.key`,
    );
}

async function readRevision(q: Queryable, releaseId: Uint8Array) {
    const row = await queryOne(
        q,
        z.object({ revision: z.coerce.bigint() }),
        sql`select revision from fact_override_revision where release_id = ${releaseId}`,
    );
    if (!row.ok) return row;
    return ok(row.value?.revision ?? null);
}

export async function listReleaseOverrides(
    db: Db,
    params: { readonly caller: Caller; readonly releaseId: Uint8Array },
): Promise<Result<ReleaseOverrides, Forbidden | NotFound | DbFailure>> {
    type Read = Result<ReleaseOverrides, NotFound | DbFailure>;
    const actions = ["facts:override"] as const;
    return await readAsStaff(db, { caller: params.caller, actions }, async (q): Promise<Read> => {
        const release = await readRelease(q, params.releaseId);
        if (!release.ok) return release;
        if (release.value === null) return err({ code: "NOT_FOUND" as const });
        const switches = await readSwitches(q, params.releaseId);
        if (!switches.ok) return switches;
        const revision = await readRevision(q, params.releaseId);
        if (!revision.ok) return revision;
        const isOff = (kind: OverrideKind, key: bigint) =>
            switches.value.some((row) => row.kind === kind && row.key === key);
        const { manifest } = release.value;
        return ok({
            releaseId: toHex(params.releaseId),
            productId: release.value.product_id,
            channel: release.value.channel,
            revision: Number(revision.value ?? 0n),
            features: manifest.features.map((feature) => ({
                key: toKeyHex(feature.key),
                tag: feature.tag,
                off: isOff("feature", feature.key),
            })),
            capabilities: manifest.capabilities.map((capability) => ({
                key: toKeyHex(capability.key),
                level: capability.level,
                off: isOff("capability", capability.key),
            })),
            switches: switches.value.map((row) => ({
                kind: row.kind,
                key: toKeyHex(row.key),
                setAt: row.set_at,
                setBy: { id: row.set_by, username: row.username },
            })),
        });
    });
}

export type SetOverrideRefusal = AuthzRefusal | NotFound | { readonly code: "UNKNOWN_TARGET" };

export async function setOverride(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly releaseId: Uint8Array;
        readonly target: OverrideTarget;
        readonly off: boolean;
        // Null on a server without native config: nothing is signed, and no module is served.
        readonly signer: OverrideSigner | null;
    },
): Promise<
    Result<{ readonly changed: boolean; readonly revision: number }, SetOverrideRefusal | DbFailure>
> {
    const { releaseId, target } = params;
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: "facts:override",
            txNow,
        });
        if (!authorized.ok) return authorized;
        // Serializes the release's switches, so each change takes the revision after the last.
        const locked = await execute(
            tx,
            sql`select pg_advisory_xact_lock(hashtextextended(
                    ${`lucent.fact-override:${toHex(releaseId)}`}, 0))`,
        );
        if (!locked.ok) return locked;
        const release = await readRelease(tx, releaseId);
        if (!release.ok) return release;
        if (release.value === null) return err({ code: "NOT_FOUND" as const });
        const switches = await readSwitches(tx, releaseId);
        if (!switches.ok) return switches;
        const revision = await readRevision(tx, releaseId);
        if (!revision.ok) return revision;
        const { manifest } = release.value;
        // The module's signed document is the only thing that turns a feature off. Without a
        // signer the change would be stored with no document, and a module that reads documents
        // would then be handed none and run what staff had switched off.
        if (params.signer === null && manifest.dataResponse === 3) {
            return err({
                code: "DB_UNAVAILABLE" as const,
                detail: "no override signing key: a switch here would never reach its modules",
            });
        }
        const plan = decideOverrideChange({
            known: {
                features: manifest.features.map((feature) => feature.key),
                capabilities: manifest.capabilities.map((capability) => capability.key),
            },
            current: switches.value,
            revision: revision.value,
            target,
            off: params.off,
        });
        if (!plan.ok) return plan;
        if (plan.value.change === "none") {
            return ok({ changed: false, revision: Number(revision.value ?? 0n) });
        }
        const at = toTimestamptz(txNow);
        const switched = await execute(
            tx,
            plan.value.change === "set"
                ? sql`insert into fact_override (release_id, kind, key, set_by, set_at)
                      values (${releaseId}, ${target.kind}, ${target.key.toString()}::numeric,
                              ${params.caller.accountId}, ${at}::timestamptz)`
                : sql`delete from fact_override
                      where release_id = ${releaseId} and kind = ${target.kind}
                        and key = ${target.key.toString()}::numeric`,
        );
        if (!switched.ok) return switched;
        const next = plan.value.revision;
        // Signed here, inside the transaction that takes the revision and raises the sessions'
        // data revisions, so all three commit together. Signed after the commit instead, a module
        // told by its lease that the revision changed could ask before the new document was
        // stored, get the old one, and never ask again: nothing would raise its revision a second
        // time. Signing is CPU work under the advisory lock above, not I/O.
        const document =
            params.signer === null
                ? null
                : await signedDocument(params.signer, {
                      release: releaseId,
                      revision: next,
                      product: release.value.product_id,
                      ...plan.value.off,
                  });
        const revised = await execute(
            tx,
            sql`insert into fact_override_revision (release_id, revision, changed_at, document)
                values (${releaseId}, ${next}, ${at}::timestamptz, ${document})
                on conflict (release_id) do update
                set revision = excluded.revision, changed_at = excluded.changed_at,
                    document = excluded.document`,
        );
        if (!revised.ok) return revised;
        const bumped = await bumpDataRevisions(tx, { releaseId, change: { kind: "override" } });
        if (!bumped.ok) return bumped;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: plan.value.change === "set" ? "fact_override.set" : "fact_override.clear",
            target: {
                releaseId: toHex(releaseId),
                kind: target.kind,
                key: toKeyHex(target.key),
                revision: Number(next),
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ changed: true, revision: Number(next) });
    });
}
