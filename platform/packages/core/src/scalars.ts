import { z } from "zod";
import {
    ACCOUNT_ID_PATTERN,
    BEARER_TOKEN_PATTERN,
    CHANNEL_ID_PATTERN,
    ENTITLEMENT_ID_PATTERN,
    FEATURE_TAG_PATTERN,
    newAccountId,
    newEntitlementId,
    newOperationId,
    newSessionId,
    OPERATION_ID_PATTERN,
    PRODUCT_ID_PATTERN,
    ROLE_ID_PATTERN,
    SESSION_ID_PATTERN,
    sha256Base64Url,
    sha256Hex,
    toBase64Url,
    toHex,
} from "./brands.ts";

// The schemas over brands.ts's patterns, for code that parses with zod; the browser imports
// brands.ts instead. The encoders and id makers live there and stay importable from here.
export {
    newAccountId,
    newEntitlementId,
    newOperationId,
    newSessionId,
    sha256Base64Url,
    sha256Hex,
    toBase64Url,
    toHex,
};

export const EpochMs = z.number().int().nonnegative().brand<"EpochMs">();
export type EpochMs = z.infer<typeof EpochMs>;

export const Seconds = z.number().int().nonnegative().brand<"Seconds">();
export type Seconds = z.infer<typeof Seconds>;

export const ServiceEpoch = z.number().int().positive().brand<"ServiceEpoch">();
export type ServiceEpoch = z.infer<typeof ServiceEpoch>;

export const AccountId = z.string().regex(ACCOUNT_ID_PATTERN).brand<"AccountId">();
export type AccountId = z.infer<typeof AccountId>;

export const RoleId = z.string().regex(ROLE_ID_PATTERN).brand<"RoleId">();
export type RoleId = z.infer<typeof RoleId>;

export const EntitlementId = z.string().regex(ENTITLEMENT_ID_PATTERN).brand<"EntitlementId">();
export type EntitlementId = z.infer<typeof EntitlementId>;

export const OperationId = z.string().regex(OPERATION_ID_PATTERN).brand<"OperationId">();
export type OperationId = z.infer<typeof OperationId>;

export const ProductId = z.string().regex(PRODUCT_ID_PATTERN).brand<"ProductId">();
export type ProductId = z.infer<typeof ProductId>;

export const ChannelId = z.string().regex(CHANNEL_ID_PATTERN).brand<"ChannelId">();
export type ChannelId = z.infer<typeof ChannelId>;

export const BearerToken = z.string().regex(BEARER_TOKEN_PATTERN).brand<"BearerToken">();
export type BearerToken = z.output<typeof BearerToken>;

// A browser session as its owner sees it in the session list; never the token or its hash.
export const SessionId = z.string().regex(SESSION_ID_PATTERN).brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

// Who is at the other end of a browser request, as web saw it from Caddy's forwarded headers.
export const ClientInfo = z.strictObject({
    ip: z.union([z.ipv4(), z.ipv6()]),
    userAgent: z.string().max(512),
});
export type ClientInfo = z.output<typeof ClientInfo>;

export const FeatureTag = z.string().regex(FEATURE_TAG_PATTERN).brand<"FeatureTag">();
export type FeatureTag = z.infer<typeof FeatureTag>;
