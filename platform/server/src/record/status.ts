import type { ProductCatalog } from "@lucent/catalog/catalog";
import { ok, type Result } from "@lucent/core/result";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, type DbFailure, queryAll, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { listPublicProducts } from "../products/products.ts";
import { decideRecoveries, type Recovery } from "./support.rules.ts";
import { readProductSupport } from "./support.ts";

// What anyone, signed out, may read of each product the public home lists: whether it works
// today, its open known issues, what changed and how long each game update took to recover from.
// A seed product is in no output: every query names the listed products. Nothing about accounts,
// sessions or counts of members. Each list is bounded and read through an index, so anyone may
// ask (web throttles per IP).

// The newest recoveries per product, each a drop and its rise.
const RECOVERY_LIMIT = 20;
const OPEN_ISSUE_LIMIT = 100;
// The status page's changelog: the newest few of each product and of the service.
const STATUS_CHANGELOG_LIMIT = 5;
// The changelog page's.
const CHANGELOG_LIMIT = 100;

export type ProductStatus = {
    readonly productId: ProductId;
    readonly name: string;
    readonly state: "announced" | "live";
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

const ChangelogRow = z.object({
    id: z.string(),
    productId: ProductId.nullable(),
    title: z.string(),
    body: z.string(),
    publishedAt: EpochMs,
    updatedAt: EpochMs,
});

const CHANGELOG_COLUMNS = sql`id::text as id, product_id as "productId", title, body,
    published_at as "publishedAt", updated_at as "updatedAt"`;

function listedProducts(catalog: ProductCatalog) {
    return listPublicProducts(catalog).filter(
        (p): p is typeof p & { readonly state: "announced" | "live" } =>
            p.state === "live" || p.state === "announced",
    );
}

export async function readPublicStatus(db: Db, params: { readonly catalog: ProductCatalog }) {
    const products = listedProducts(params.catalog);
    const ids = products.map((p) => p.id);
    return await withTx(db, async (tx, txNow) => {
        const statuses: ProductStatus[] = [];
        const changelog: z.output<typeof ChangelogRow>[] = [];
        for (const product of products) {
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
            const entries = await queryAll(
                tx,
                ChangelogRow,
                sql`select ${CHANGELOG_COLUMNS} from changelog_entry
                    where product_id = ${product.id}
                    order by published_at desc, id desc limit ${STATUS_CHANGELOG_LIMIT}`,
            );
            if (!entries.ok) return entries;
            changelog.push(...entries.value);
        }
        const service = await queryAll(
            tx,
            ChangelogRow,
            sql`select ${CHANGELOG_COLUMNS} from changelog_entry where product_id is null
                order by published_at desc, id desc limit ${STATUS_CHANGELOG_LIMIT}`,
        );
        if (!service.ok) return service;
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
        return ok({
            at: txNow,
            products: statuses,
            issues: issues.value,
            changelog: [...service.value, ...changelog].toSorted(
                (a, b) => b.publishedAt - a.publishedAt,
            ),
        });
    });
}

export async function listPublicChangelog(
    db: Db,
    params: { readonly catalog: ProductCatalog },
): Promise<
    Result<
        {
            readonly at: EpochMs;
            readonly entries: readonly z.output<typeof ChangelogRow>[];
            readonly names: readonly { readonly id: ProductId; readonly name: string }[];
        },
        DbFailure
    >
> {
    const products = listedProducts(params.catalog);
    return await withTx(db, async (tx, txNow) => {
        const entries = await queryAll(
            tx,
            ChangelogRow,
            sql`select ${CHANGELOG_COLUMNS} from changelog_entry
                where product_id is null or product_id = any(${products.map((p) => p.id)}::text[])
                order by published_at desc, id desc limit ${CHANGELOG_LIMIT}`,
        );
        if (!entries.ok) return entries;
        return ok({
            at: txNow,
            entries: entries.value,
            names: products.map(({ id, name }) => ({ id, name })),
        });
    });
}
