import type { ModuleKey } from "@lucent/bundle/fact-set";
import type { ReleaseManifestV3 } from "@lucent/bundle/release-manifest";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import type { ProductDefinition } from "@lucent/catalog/product";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { ChannelId, EpochMs, ProductId, toHex } from "@lucent/core/scalars";
import type { StartReply } from "@lucent/wire/start";
import type { EffectiveProductAccess } from "../../identity/authority/entitlements.ts";
import type { DeviceRow } from "../../identity/devices/devices.ts";
import type { CurrentRelease } from "../releases/reads.ts";

type Code<C extends string> = { readonly code: C };

export function decideStartDevice(
    device: DeviceRow | null,
): Result<DeviceRow, Code<"DEVICE_REVOKED">> {
    return device === null || device.revokedAt !== null
        ? err({ code: "DEVICE_REVOKED" })
        : ok(device);
}

export function decideStartReplay(
    id: Uint8Array,
    row: {
        readonly consumed_at: EpochMs | null;
        readonly expires_at: EpochMs;
        readonly container_key: Uint8Array | null;
        readonly seal: Uint8Array;
    } | null,
    txNow: EpochMs,
): Result<StartReply, Code<"START_EXPIRED">> {
    if (
        row === null ||
        row.consumed_at !== null ||
        row.expires_at <= txNow ||
        row.container_key === null
    ) {
        return err({ code: "START_EXPIRED" });
    }
    return ok({ start: id, containerKey: row.container_key, releaseSeal: row.seal });
}

// A product that isn't open yet answers exactly as one that doesn't exist.
export function decideStartProduct(
    catalog: ProductCatalog,
    requested: string,
): Result<ProductDefinition, Code<"NOT_FOUND">> {
    const id = ProductId.safeParse(requested);
    const product = id.success ? catalog.get(id.data) : undefined;
    if (product === undefined || product.kind !== "module") return err({ code: "NOT_FOUND" });
    const { startRefusal } = decideProductLifecycle(product.state).value;
    return startRefusal === "NOT_FOUND" ? err({ code: "NOT_FOUND" }) : ok(product);
}

// A retired product answers as one with no release, and where a missing release would: after
// entitlement and the loader, so an account that never held it learns nothing from the refusal.
export function decideStartOpen(
    product: ProductDefinition,
): Result<void, Code<"RELEASE_UNAVAILABLE">> {
    const { startRefusal } = decideProductLifecycle(product.state).value;
    return startRefusal === null ? ok(undefined) : err({ code: "RELEASE_UNAVAILABLE" });
}

// For a start already made: whether its product still takes starts at all.
export function decideStartStillOpen(
    catalog: ProductCatalog,
    productId: string,
): Result<ProductDefinition, Code<"NOT_FOUND" | "RELEASE_UNAVAILABLE">> {
    const product = decideStartProduct(catalog, productId);
    if (!product.ok) return product;
    const open = decideStartOpen(product.value);
    return open.ok ? product : open;
}

export function decideStartAccess(
    access: EffectiveProductAccess,
    requested: string,
): Result<ChannelId, Code<"ENTITLEMENT_INACTIVE" | "CHANNEL_NOT_ALLOWED">> {
    if (!access.isEntitled) return err({ code: "ENTITLEMENT_INACTIVE" });
    const channel = ChannelId.parse(requested);
    return access.channels.includes(channel) ? ok(channel) : err({ code: "CHANNEL_NOT_ALLOWED" });
}

export function decideStartLoader(
    current: Uint8Array | null,
    requested: Uint8Array,
): Result<void, Code<"RELEASE_UNAVAILABLE" | "LOADER_UPDATE_REQUIRED">> {
    if (current === null) return err({ code: "RELEASE_UNAVAILABLE" });
    if (toHex(current) !== toHex(requested)) return err({ code: "LOADER_UPDATE_REQUIRED" });
    return ok(undefined);
}

export function decideStartRelease(
    current: CurrentRelease | null,
): Result<CurrentRelease, Code<"RELEASE_UNAVAILABLE">> {
    if (current === null) return err({ code: "RELEASE_UNAVAILABLE" });
    invariant(current.hasContainer, "a module product's current release has a container");
    return ok(current);
}

export function decideNeededFacts(
    manifest: Pick<ReleaseManifestV3, "facts" | "capabilities">,
    builds: readonly ModuleKey[],
): Result<ReadonlySet<bigint>, never> {
    const moduleOf = new Map(manifest.facts.map((fact) => [fact.key, fact.module]));
    const reported = new Set(builds.map((build) => build.nameHash));
    const needed = new Set<bigint>();
    for (const capability of manifest.capabilities) {
        const modules = capability.members.map((member) => moduleOf.get(member));
        invariant(!modules.includes(undefined), "a capability's members are among the facts");
        if (
            capability.level === "core" &&
            modules.every((m) => m !== undefined && reported.has(m))
        ) {
            for (const member of capability.members) needed.add(member);
        }
    }
    return ok(needed);
}

export function decideStart(
    covered: { readonly coreFacts: boolean },
    txNow: EpochMs,
    ttlMs: number,
): Result<EpochMs, Code<"GAME_BUILD_UNSUPPORTED">> {
    return covered.coreFacts
        ? ok(EpochMs.parse(txNow + ttlMs))
        : err({ code: "GAME_BUILD_UNSUPPORTED" });
}
