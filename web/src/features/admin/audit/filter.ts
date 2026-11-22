import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { parseQuery } from "../query.ts";

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
    const at = EpochMs.safeParse(Date.UTC(year, month - 1, day));
    return at.success ? at.data : null;
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
    const target = AccountId.safeParse(tokens.target);
    const filter: AuditFilter = {
        actorId: named(tokens.actor),
        targetAccountId: target.success ? target.data : null,
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

const Reason = z.object({ reason: z.string().min(1) });
const Rename = z.object({ from: z.string().nullable(), to: z.string() });
const RoleChange = z.object({ roleId: z.string().min(1), expiresAt: EpochMs.nullish() });
const SealPromotion = z.object({
    productId: z.string(),
    channel: z.string(),
    number: z.string(),
    previous: z.string().nullable(),
});
const FactSetPromotion = z.object({ revision: z.number(), builds: z.array(z.unknown()) });

// What an entry's free-form detail says, as much as fits a table cell. Rows outlive the code
// that wrote them, so anything that doesn't match its operation's shape shows nothing.
export function auditDetail(
    operation: string,
    detail: Readonly<Record<string, unknown>>,
): AuditDetail {
    const reason = Reason.safeParse(detail);
    if (reason.success) return { kind: "reason", reason: reason.data.reason };
    if (operation === "account.rename") {
        const rename = Rename.safeParse(detail);
        if (rename.success) return { kind: "rename", ...rename.data };
    }
    if (operation === "role.assign" || operation === "role.unassign") {
        const role = RoleChange.safeParse(detail);
        if (role.success) {
            return {
                kind: "role",
                roleId: role.data.roleId,
                expiresAt: operation === "role.assign" ? (role.data.expiresAt ?? null) : null,
            };
        }
    }
    if (operation === "release.promote") {
        const seal = SealPromotion.safeParse(detail);
        if (seal.success) return { kind: "seal", ...seal.data };
    }
    if (operation === "fact_set.promote") {
        const set = FactSetPromotion.safeParse(detail);
        if (set.success) {
            return { kind: "factSet", revision: set.data.revision, builds: set.data.builds.length };
        }
    }
    return { kind: "none" };
}
