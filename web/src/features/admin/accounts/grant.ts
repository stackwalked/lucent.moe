import { err, ok, type Result } from "@lucent/core/result";
import { ChannelId, type EpochMs, FeatureTag, ProductId } from "@lucent/core/scalars";
import { untilFrom } from "./until.ts";

// The entitlement form as typed, read into what platform takes: one product, the channels ticked
// (only ones the product has), every feature or the listed tags, and an optional last day.

export type GrantForm = {
    readonly productId: string;
    readonly channels: readonly string[];
    readonly features: string;
    readonly until: string;
};

export type Grant = {
    readonly productId: ProductId;
    readonly channels: readonly ChannelId[];
    readonly features: "*" | readonly FeatureTag[];
    readonly validUntil: EpochMs | null;
};

export type GrantProblem = "unknownProduct" | "noChannel" | "badFeature" | "untilPast";

type CatalogEntry = { readonly id: string; readonly channels: readonly string[] };

// Empty or "*" is every feature; otherwise tags split on commas and spaces, each one valid.
export function parseFeatures(raw: string): "*" | readonly FeatureTag[] | null {
    const words = raw
        .split(/[\s,]+/)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length > 0);
    if (words.length === 0 || (words.length === 1 && words[0] === "*")) return "*";
    const tags: FeatureTag[] = [];
    for (const word of words) {
        const tag = FeatureTag.safeParse(word);
        if (!tag.success) return null;
        if (!tags.includes(tag.data)) tags.push(tag.data);
    }
    return tags;
}

export function parseGrant(
    form: GrantForm,
    catalog: readonly CatalogEntry[],
    now: EpochMs,
): Result<Grant, GrantProblem> {
    const product = catalog.find((entry) => entry.id === form.productId);
    const productId = ProductId.safeParse(form.productId);
    if (product === undefined || !productId.success) return err("unknownProduct");
    const channels = product.channels.filter((channel) => form.channels.includes(channel));
    if (channels.length === 0) return err("noChannel");
    const features = parseFeatures(form.features);
    if (features === null) return err("badFeature");
    const validUntil = untilFrom(form.until);
    if (validUntil !== null && validUntil <= now) return err("untilPast");
    return ok({
        productId: productId.data,
        channels: channels.map((channel) => ChannelId.parse(channel)),
        features,
        validUntil,
    });
}

export type EntitlementState = "active" | "suspended" | "revoked" | "ended" | "upcoming";

// What an entitlement grants now: its status, then its window. Effective access unions only the
// active ones inside their window, as platform does at a start.
export function entitlementState(
    entitlement: {
        readonly status: "active" | "suspended" | "revoked";
        readonly validFrom: EpochMs;
        readonly validUntil: EpochMs | null;
    },
    now: EpochMs,
): EntitlementState {
    if (entitlement.status !== "active") return entitlement.status;
    if (entitlement.validUntil !== null && entitlement.validUntil <= now) return "ended";
    if (entitlement.validFrom > now) return "upcoming";
    return "active";
}
