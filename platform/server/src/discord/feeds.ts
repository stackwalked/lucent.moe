import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import type { FeedKind } from "@lucent/rpc/discord/rules";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { readReleaseSupported } from "../products/products.ts";
import { listRules } from "./rules.ts";

// A feed channel is anyone's to read, so it is told only what the public home shows: products
// listed to someone holding nothing, and their first channel's releases. A resource naming a
// product goes out only when that product is listed so.

export type FeedPost = {
    readonly ruleId: string;
    readonly channelId: string;
    readonly feed: FeedKind;
    readonly subject: string;
    readonly state: string;
    readonly url: string;
    readonly post:
        | {
              readonly kind: "status";
              readonly product: string;
              readonly state: "announced" | "live";
              readonly supported: boolean | null;
          }
        | { readonly kind: "resources"; readonly title: string; readonly product: string | null }
        | {
              readonly kind: "releases";
              readonly product: string;
              readonly channel: ChannelId;
              readonly number: string;
              readonly promotedAt: EpochMs;
          };
};

// Per rule, so one channel's backlog never holds back another's.
const POSTS_PER_READ = 20;

function publicProducts(catalog: ProductCatalog): readonly ProductDefinition[] {
    return [...catalog.values()].filter((p) => decideProductLifecycle(p.state).value.listed);
}

const CurrentRowSchema = z.object({
    product_id: ProductId,
    channel: ChannelId,
    number: z.string(),
    promoted_at: EpochMs,
    release_id: z.instanceof(Uint8Array),
});

async function readCurrentReleases(q: Queryable) {
    return await queryAll(
        q,
        CurrentRowSchema,
        sql`select c.product_id, c.channel, c.number::text as number, c.promoted_at, s.release_id
            from current_release c
            join release_seal s on s.product_id = c.product_id and s.channel = c.channel
                               and s.number = c.number`,
    );
}

type ProductStatus = Extract<FeedPost["post"], { kind: "status" }>;

async function readStatuses(
    tx: Tx,
    catalog: ProductCatalog,
    current: readonly z.output<typeof CurrentRowSchema>[],
): Promise<Result<ReadonlyMap<ProductId, ProductStatus>, DbFailure>> {
    const statuses = new Map<ProductId, ProductStatus>();
    for (const product of publicProducts(catalog)) {
        if (product.state !== "live" && product.state !== "announced") continue;
        const first = product.channels[0];
        const release = current.find(
            (row) => row.product_id === product.id && row.channel === first,
        );
        let supported: boolean | null = null;
        if (product.state === "live" && release !== undefined) {
            supported = true;
            if (product.kind === "module") {
                const covered = await readReleaseSupported(tx, {
                    productId: product.id,
                    releaseId: release.release_id,
                });
                if (!covered.ok) return covered;
                supported = covered.value;
            }
        }
        statuses.set(product.id, {
            kind: "status",
            product: product.name,
            state: product.state,
            supported,
        });
    }
    return ok(statuses);
}

// What the public home says of each product it lists: for /status, and the status feed.
export async function readPublicStatuses(tx: Tx, catalog: ProductCatalog) {
    const current = await readCurrentReleases(tx);
    if (!current.ok) return current;
    return await readStatuses(tx, catalog, current.value);
}

const PostedRowSchema = z.object({ subject: z.string(), state: z.string() });

export async function readPendingPosts(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly siteOrigin: string },
): Promise<Result<{ readonly posts: readonly FeedPost[] }, DbFailure>> {
    const { catalog, siteOrigin } = params;
    return await withTx(db, async (tx) => {
        const rules = await listRules(tx);
        if (!rules.ok) return rules;
        const current = await readCurrentReleases(tx);
        if (!current.ok) return current;
        const listed = new Map(publicProducts(catalog).map((p) => [p.id, p]));
        const posts: FeedPost[] = [];
        for (const rule of rules.value) {
            if (rule.fields.kind !== "feed") continue;
            const base = {
                ruleId: rule.id,
                channelId: rule.fields.channelId,
                feed: rule.fields.feed,
            };
            // The latest state each subject was posted in, for status; any post, for the others.
            const posted = await queryAll(
                tx,
                PostedRowSchema,
                sql`select distinct on (subject) subject, state from connector_discord_post
                    where rule_id = ${rule.id}::uuid order by subject, posted_at desc`,
            );
            if (!posted.ok) return posted;
            const said = new Map(posted.value.map((row) => [row.subject, row.state]));
            switch (rule.fields.feed) {
                case "status": {
                    const statuses = await readStatuses(tx, catalog, current.value);
                    if (!statuses.ok) return statuses;
                    for (const [productId, status] of statuses.value) {
                        const state = `${status.state}:${String(status.supported)}`;
                        if (said.get(productId) === state) continue;
                        posts.push({
                            ...base,
                            subject: productId,
                            state,
                            url: `${siteOrigin}/`,
                            post: status,
                        });
                    }
                    break;
                }
                case "resources": {
                    const resources = await queryAll(
                        tx,
                        z.object({
                            id: z.string(),
                            title: z.string(),
                            product_id: ProductId.nullable(),
                        }),
                        // Unlisted products are left out here, not after the limit: skipped
                        // rows would otherwise fill every read and hold back the rest for good.
                        sql`select r.id::text as id, r.title, r.product_id from resource r
                            where r.published_at >= ${toTimestamptz(rule.createdAt)}::timestamptz
                              and (r.product_id is null
                                   or r.product_id = any(${[...listed.keys()]}::text[]))
                              and not exists (select 1 from connector_discord_post p
                                              where p.rule_id = ${rule.id}::uuid
                                                and p.subject = r.id::text)
                            order by r.published_at, r.id
                            limit ${POSTS_PER_READ}`,
                    );
                    if (!resources.ok) return resources;
                    for (const resource of resources.value) {
                        const product =
                            resource.product_id === null ? null : listed.get(resource.product_id);
                        if (product === undefined) continue;
                        posts.push({
                            ...base,
                            subject: resource.id,
                            state: "published",
                            url: `${siteOrigin}/resources`,
                            post: {
                                kind: "resources",
                                title: resource.title,
                                product: product?.name ?? null,
                            },
                        });
                    }
                    break;
                }
                case "releases": {
                    for (const row of current.value) {
                        const product = listed.get(row.product_id);
                        if (product === undefined || product.channels[0] !== row.channel) continue;
                        if (row.promoted_at < rule.createdAt) continue;
                        const subject = `${row.product_id}:${row.channel}:${row.number}`;
                        if (said.has(subject)) continue;
                        posts.push({
                            ...base,
                            subject,
                            state: "promoted",
                            url: `${siteOrigin}/products/${row.product_id}`,
                            post: {
                                kind: "releases",
                                product: product.name,
                                channel: row.channel,
                                number: row.number,
                                promotedAt: row.promoted_at,
                            },
                        });
                    }
                    break;
                }
            }
        }
        return ok({ posts });
    });
}

// A rule removed since the read records nothing: there is no channel left to have told.
export async function recordPost(
    db: Db,
    params: {
        readonly ruleId: string;
        readonly subject: string;
        readonly state: string;
        readonly messageId: string;
    },
): Promise<Result<void, DbFailure>> {
    const written = await execute(
        db,
        sql`insert into connector_discord_post (rule_id, subject, state, message_id, posted_at)
            select id, ${params.subject}, ${params.state}, ${params.messageId}, now()
            from connector_discord_rule where id = ${params.ruleId}::uuid and kind = 'feed'
            on conflict (rule_id, subject, state)
            do update set message_id = excluded.message_id, posted_at = excluded.posted_at`,
    );
    return written.ok ? ok(undefined) : written;
}
