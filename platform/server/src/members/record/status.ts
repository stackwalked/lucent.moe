import type { ProductCatalog } from "@lucent/catalog/catalog";
import type { ProductState } from "@lucent/catalog/product";
import { trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import {
    type AccountId,
    type BearerToken,
    EpochMs,
    ProductId,
    toBase64Url,
} from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    queryAll,
    sql,
    type Tx,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { isListedForMember } from "../../delivery/products/visibility.ts";
import { readSession, type SessionInvalid } from "../../identity/auth/sessions.ts";
import { CHANGELOG_COLUMNS, ChangelogRow } from "./notes.ts";
import { decideRecoveries, type Recovery } from "./support.rules.ts";
import { readProductSupport } from "./support.ts";

// What a member may read of the record: the products listed for them (a seed product they hold
// included), whether each works today, the open issues of those products and of the service, and
// the changelog of everything they may see. The loader is not a product, so it is never in the
// products list; its entries are their own subject. Every list is bounded and read through an
// index.

// The newest recoveries per product, each a drop and its rise.
const RECOVERY_LIMIT = 20;
const OPEN_ISSUE_LIMIT = 100;
// The changelog page size.
export const CHANGELOG_PAGE = 25;

const LOADER_ID = ProductId.parse("lucent-loader");

export type ProductStatus = {
    readonly productId: ProductId;
    readonly name: string;
    readonly state: ProductState;
    // null: nothing to say yet (announced, or nothing promoted).
    readonly supported: boolean | null;
    readonly recoveries: readonly Recovery[];
};

const IssueRow = z.object({
    id: z.string(),
    productId: ProductId.nullable(),
    title: z.string(),
    body: z.string(),
    openedAt: EpochMs,
    updatedAt: EpochMs,
});

async function readMember(
    tx: Tx,
    sessionToken: BearerToken,
    txNow: EpochMs,
): Promise<Result<{ readonly accountId: AccountId }, SessionInvalid | DbFailure>> {
    const session = await readSession(tx, {
        token: sessionToken,
        txNow,
        purposes: ["member"],
    });
    if (!session.ok) return session;
    return ok({ accountId: session.value.accountId });
}

// Every product listed for this member, in catalog order, the loader left out: it is not a
// product.
async function listedForMember(
    tx: Tx,
    params: { readonly catalog: ProductCatalog; readonly accountId: AccountId },
) {
    const products = [];
    for (const product of params.catalog.values()) {
        if (product.id === LOADER_ID) continue;
        const listed = await isListedForMember(
            tx,
            { accountId: params.accountId, catalog: params.catalog },
            product.id,
        );
        if (!listed.ok) return listed;
        if (listed.value) products.push(product);
    }
    return ok(products);
}

export async function readMemberStatus(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly sessionToken: BearerToken },
) {
    return await withTx(db, async (tx, txNow) => {
        const member = await readMember(tx, params.sessionToken, txNow);
        if (!member.ok) return member;
        const listed = await listedForMember(tx, {
            catalog: params.catalog,
            accountId: member.value.accountId,
        });
        if (!listed.ok) return listed;
        const statuses: ProductStatus[] = [];
        for (const product of listed.value) {
            const supported = await readProductSupport(tx, product);
            if (!supported.ok) return supported;
            const changes = await queryAll(
                tx,
                z.object({ supported: z.boolean(), changed_at: EpochMs }),
                sql`select supported, changed_at from product_support_change
                    where product_id = ${product.id}
                    order by id desc limit ${RECOVERY_LIMIT * 2 + 1}`,
            );
            if (!changes.ok) return changes;
            const recoveries = decideRecoveries({
                changes: changes.value
                    .toReversed()
                    .map((row) => ({ supported: row.supported, changedAt: row.changed_at })),
                txNow,
            });
            if (!recoveries.ok) return recoveries;
            statuses.push({
                productId: product.id,
                name: product.name,
                state: product.state,
                supported: supported.value,
                recoveries:
                    product.state === "live" ? recoveries.value.slice(0, RECOVERY_LIMIT) : [],
            });
        }
        const ids = listed.value.map((p) => p.id);
        const issues = await queryAll(
            tx,
            IssueRow,
            sql`select id::text as id, product_id as "productId", title, body,
                       opened_at as "openedAt", updated_at as "updatedAt"
                from known_issue
                where closed_at is null
                  and (product_id is null or product_id = any(${ids}::text[]))
                order by opened_at desc, id desc limit ${OPEN_ISSUE_LIMIT}`,
        );
        if (!issues.ok) return issues;
        return ok({ products: statuses, issues: issues.value });
    });
}

// A cursor is the last row's sort key as base64url JSON: opaque to web, checked on the way back.
function toCursor(key: readonly [EpochMs, string]): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(key)));
}

const CursorKey = z.tuple([EpochMs, z.string()]);

function fromCursor(
    cursor: string,
): Result<readonly [EpochMs, string], { readonly code: "INVALID_CURSOR" }> {
    const decoded = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(cursor, { alphabet: "base64url" }),
                ),
            ),
        () => ({ code: "INVALID_CURSOR" as const }),
    );
    if (!decoded.ok) return decoded;
    const parsed = CursorKey.safeParse(decoded.value);
    return parsed.success ? ok(parsed.data) : err({ code: "INVALID_CURSOR" });
}

type ListInput = {
    // Absent: everything the member may see. Null: the service's entries only. A product id:
    // that product's (a product the member may not see is an empty page, never a refusal).
    readonly productId?: ProductId | null | undefined;
    readonly subject?: "product" | "loader" | "service" | undefined;
    readonly cursor?: string | undefined;
};

export async function listMemberChangelog(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly sessionToken: BearerToken;
        readonly input: ListInput;
    },
): Promise<
    Result<
        {
            readonly entries: readonly z.output<typeof ChangelogRow>[];
            readonly next: string | null;
            readonly names: readonly { readonly id: ProductId; readonly name: string }[];
        },
        SessionInvalid | DbFailure | { readonly code: "INVALID_CURSOR" }
    >
> {
    let key: readonly [EpochMs, string] | null = null;
    if (params.input.cursor !== undefined) {
        const parsed = fromCursor(params.input.cursor);
        if (!parsed.ok) return parsed;
        key = parsed.value;
    }
    return await withTx(db, async (tx, txNow) => {
        const member = await readMember(tx, params.sessionToken, txNow);
        if (!member.ok) return member;
        const listed = await listedForMember(tx, {
            catalog: params.catalog,
            accountId: member.value.accountId,
        });
        if (!listed.ok) return listed;
        const ids = listed.value.map((p) => p.id);
        // What the filter means in row terms: service and loader entries, and product entries of
        // the products the member may see.
        const visible = sql`(subject in ('service', 'loader') or product_id = any(${ids}::text[]))`;
        const scoped =
            params.input.productId === undefined
                ? visible
                : params.input.productId === null
                  ? sql`subject = 'service'`
                  : ids.includes(params.input.productId)
                    ? sql`product_id = ${params.input.productId}`
                    : sql`false`;
        const narrowed =
            params.input.subject === undefined
                ? scoped
                : sql`(${scoped}) and subject = ${params.input.subject}`;
        const after =
            key === null
                ? sql`true`
                : sql`(published_at, id) < (${toTimestamptz(key[0])}::timestamptz, ${key[1]}::uuid)`;
        const rows = await queryAll(
            tx,
            ChangelogRow,
            sql`select ${CHANGELOG_COLUMNS} from changelog_entry
                where (${narrowed}) and (${after})
                order by published_at desc, id desc limit ${CHANGELOG_PAGE + 1}`,
        );
        if (!rows.ok) return rows;
        const entries = rows.value.slice(0, CHANGELOG_PAGE);
        const last = entries.at(-1);
        return ok({
            entries,
            next:
                rows.value.length > CHANGELOG_PAGE && last !== undefined
                    ? toCursor([last.publishedAt, last.id])
                    : null,
            names: listed.value.map(({ id, name }) => ({ id, name })),
        });
    });
}
