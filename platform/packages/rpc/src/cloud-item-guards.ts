// The cloud item values without zod, for the browser; cloud-item.ts builds the schemas from them.
// PostgreSQL int8 identities travel as decimal strings, without rounding through JS numbers.
export const CLOUD_ID_PATTERN = /^[1-9]\d{0,18}$/;

export const withinInt8 = (digits: string): boolean =>
    digits.length < 19 || digits <= "9223372036854775807";

export const isCloudId = (value: unknown): value is string =>
    typeof value === "string" && CLOUD_ID_PATTERN.test(value) && withinInt8(value);

export const ITEM_KINDS = ["config", "inventory", "script"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

const utf8 = new TextEncoder();

// Every writer's rule, the site's and a running session's: not blank, well formed, no NUL, at
// most 64 code points and 255 UTF-8 bytes, so the /data list can carry every name (its name size
// is a u8).
export const isCloudItemName = (name: string): boolean =>
    name.trim().length > 0 &&
    name.isWellFormed() &&
    !name.includes("\0") &&
    [...name].length <= 64 &&
    utf8.encode(name).byteLength <= 255;

export const isItemKind = (value: unknown): value is ItemKind =>
    ITEM_KINDS.some((kind) => kind === value);
