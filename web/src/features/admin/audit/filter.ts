import { type AccountId, type EpochMs, isAccountId, isEpochMs } from "@lucent/core/brands";
import { isUuid } from "../../../formats.ts";
import { parseQuery } from "../query.ts";
import { AUDIT_COPY } from "./copy.ts";

export const AUDIT_KEYS = ["actor", "target", "op", "before"] as const;

export type AuditFilter = {
    readonly actorId: string | null;
    readonly targetAccountId: AccountId | null;
    readonly operation: string | null;
    readonly before: EpochMs | null;
};

// Ids and names as platform writes them ("acc_...", "cli:bootstrap", "account.suspend"); the
// length is the contract's own limit.
const NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// 00:00 UTC of a real calendar day from 1970 on, else null. Date.UTC would roll "2026-02-31"
// over into March, so the day is checked against the month's length first.
export function startOfDayUtc(text: string): EpochMs | null {
    const match = DATE.exec(text);
    if (match === null) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (year < 1970 || month < 1 || month > 12 || day < 1) return null;
    const monthLength = (Date.UTC(year, month, 1) - Date.UTC(year, month - 1, 1)) / DAY_MS;
    if (day > monthLength) return null;
    const at = Date.UTC(year, month - 1, day);
    return isEpochMs(at) ? at : null;
}

function named(value: string | undefined): string | null {
    return value !== undefined && NAME.test(value) ? value : null;
}

// ?q= as platform's audit filter. Free text means nothing here, and a token whose value doesn't
// fit its key is left out rather than refused: the list shows what the rest of the query asks,
// and the page says which tokens it ignored.
export function readAuditQuery(q: string | undefined): {
    readonly filter: AuditFilter;
    readonly ignored: readonly string[];
} {
    const { tokens, ignored } = parseQuery(q, AUDIT_KEYS);
    const target = tokens.target;
    const filter: AuditFilter = {
        actorId: named(tokens.actor),
        targetAccountId: isAccountId(target) ? target : null,
        operation: named(tokens.op),
        before: tokens.before === undefined ? null : startOfDayUtc(tokens.before),
    };
    const used = {
        actor: filter.actorId,
        target: filter.targetAccountId,
        op: filter.operation,
        before: filter.before,
    };
    const unfit = AUDIT_KEYS.flatMap((key) => {
        const value = tokens[key];
        return value !== undefined && used[key] === null ? [`${key}:${value}`] : [];
    });
    return { filter, ignored: [...ignored, ...unfit] };
}

export function auditFilter(q: string | undefined): AuditFilter {
    return readAuditQuery(q).filter;
}

export type AuditDetail =
    | { readonly kind: "none" }
    | { readonly kind: "reason"; readonly reason: string }
    | { readonly kind: "rename"; readonly from: string | null; readonly to: string }
    | { readonly kind: "role"; readonly roleId: string; readonly expiresAt: EpochMs | null }
    | {
          readonly kind: "seal";
          readonly productId: string;
          readonly channel: string;
          readonly number: string;
          readonly previous: string | null;
      }
    | { readonly kind: "factSet"; readonly revision: number; readonly builds: number };

// Each shape as its zod object was: z.string() a string, .min(1) not empty, z.number() finite,
// .nullable() also null, .nullish() also null or missing. Keys a shape doesn't name are dropped.
const isText = (value: unknown): value is string => typeof value === "string";
const isFilled = (value: unknown): value is string => isText(value) && value.length > 0;
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isEpochMsOrNull = (value: unknown): value is EpochMs | null =>
    value === null || isEpochMs(value);
const isNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

// What an entry's free-form detail says, as much as fits a table cell. Rows outlive the code
// that wrote them, so anything that doesn't match its operation's shape shows nothing.
export function auditDetail(
    operation: string,
    detail: Readonly<Record<string, unknown>>,
): AuditDetail {
    if (operation === "mail.delivery_dead") {
        const reference = detail["deliveryId"];
        const outcome =
            detail["outcome"] === "refused" ? AUDIT_COPY.refusedMail : AUDIT_COPY.unconfirmedMail;
        return {
            kind: "reason",
            reason: isUuid(reference) ? `${outcome} · ${reference}` : outcome,
        };
    }
    const reason = detail["reason"];
    if (isFilled(reason)) return { kind: "reason", reason };
    if (operation === "account.rename") {
        const from = detail["from"];
        const to = detail["to"];
        if (isTextOrNull(from) && isText(to)) return { kind: "rename", from, to };
    }
    if (operation === "role.assign" || operation === "role.unassign") {
        const roleId = detail["roleId"];
        const expiresAt = detail["expiresAt"];
        if (isFilled(roleId) && (expiresAt === undefined || isEpochMsOrNull(expiresAt))) {
            return {
                kind: "role",
                roleId,
                expiresAt: operation === "role.assign" ? (expiresAt ?? null) : null,
            };
        }
    }
    if (operation === "release.promote") {
        const productId = detail["productId"];
        const channel = detail["channel"];
        const number = detail["number"];
        const previous = detail["previous"];
        if (isText(productId) && isText(channel) && isText(number) && isTextOrNull(previous)) {
            return { kind: "seal", productId, channel, number, previous };
        }
    }
    if (operation === "fact_set.promote") {
        const revision = detail["revision"];
        const builds = detail["builds"];
        if (isNumber(revision) && Array.isArray(builds)) {
            return { kind: "factSet", revision, builds: builds.length };
        }
    }
    return { kind: "none" };
}
