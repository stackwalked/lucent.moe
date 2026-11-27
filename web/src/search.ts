import { type ItemKind, isCloudId, isItemKind } from "@lucent/rpc/cloud-item-guards";
import { isUuid } from "./formats.ts";

// A route's search as the router validates it, without zod in the page: a plain reader behind the
// Standard Schema interface. router-core (1.171) raises a SearchParamError for its issues, as it
// did for a zod schema's, so a search that doesn't fit fails the route the same way.

export type Search = Readonly<Record<string, unknown>>;

type Validated<T> =
    | { readonly value: T; readonly issues?: undefined }
    | { readonly issues: readonly { readonly message: string }[] };

export type SearchSchema<T, In> = {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: { readonly input: In; readonly output: T };
        readonly validate: (value: unknown) => Validated<T>;
    };
};

// As z.object(): an object, not an array; keys it doesn't read are dropped.
const isSearch = (value: unknown): value is Search =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// The reader returns null to refuse. In is what a link may pass: plain strings where the reader
// brands them, as a zod schema's input type was.
export function searchSchema<T, In = T>(read: (search: Search) => T | null): SearchSchema<T, In> {
    return {
        "~standard": {
            version: 1,
            vendor: "lucent",
            validate: (value) => {
                const parsed = isSearch(value) ? read(value) : null;
                return parsed === null
                    ? { issues: [{ message: "the search does not fit this page" }] }
                    : { value: parsed };
            },
        },
    };
}

// One key as zod's .optional(): missing or undefined is left out, anything else must pass the
// guard, else null (refused).
export function optional<K extends string, T>(
    search: Search,
    key: K,
    is: (value: unknown) => value is T,
): Partial<Record<K, T>> | null {
    const value = search[key];
    if (value === undefined) return {};
    if (!is(value)) return null;
    const field: Partial<Record<K, T>> = {};
    field[key] = value;
    return field;
}

const LIST_QUERY_MAX = 200;
const FIND_MAX = 64;

const isFind = (value: unknown): value is string =>
    typeof value === "string" && value.length <= FIND_MAX;

const isListQuery = (value: unknown): value is string =>
    typeof value === "string" && value.length <= LIST_QUERY_MAX;

// The admin lists' ?q=.
export const listSearch = searchSchema((search) => optional(search, "q", isListQuery));

// The inbox's ?cursor=, a page's place in the inbox.
export const inboxSearch = searchSchema((search) => optional(search, "cursor", isUuid));

// The cloud page's ?item=, ?kind= and ?find=: the product's listings and items
// (narrowed by kind and a name or summary search), or one item's history.
export const cloudSearch = searchSchema<
    {
        readonly item?: string;
        readonly kind?: ItemKind;
        readonly find?: string;
    },
    {
        readonly item?: string;
        readonly kind?: string;
        readonly find?: string;
    }
>((search) => {
    const item = optional(search, "item", isCloudId);
    const kind = optional(search, "kind", isItemKind);
    const find = optional(search, "find", isFind);
    return item === null || kind === null || find === null ? null : { ...item, ...kind, ...find };
});
