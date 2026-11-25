-- The public record of whether each live module product works today (record/support.ts).
--
-- Lock order: a writer reads `product_support` unlocked and writes it only when the state it
-- computed differs, after the build coverage lock (facts/coverage-lock.ts) and before audit.
-- No account is locked here: followers are told later, by record/followers.ts.

-- Product-scoped: the support state last recorded for a live module product, and the channel it
-- is judged on (the product's first, as the public home shows it). A start writes the row; a fact
-- set promotion recomputes it from the stored channel, holding no catalog.
create table product_support (
    product_id  text primary key,
    channel     text not null,
    supported   boolean not null,
    changed_at  timestamptz not null
);

-- Product-scoped: each change of a product's recorded support state, once. A drop opens an
-- outage and the next rise closes it: the recovery history pairs them. A drop's followers are
-- told by a job that walks them in account order: `notified_through` is the last account told,
-- `notified_at` set when the walk is done (or skipped, the state having moved on). Public: no
-- account, session or count is kept.
create table product_support_change (
    id                bigint generated always as identity primary key,
    product_id        text not null,
    supported         boolean not null,
    changed_at        timestamptz not null,
    notified_through  text,
    notified_at       timestamptz,
    -- A rise tells nobody: it is written as done.
    check (not supported or notified_at is not null)
);

create index product_support_change_product_idx on product_support_change (product_id, id desc);
create index product_support_change_pending_idx on product_support_change (id)
    where notified_at is null;
