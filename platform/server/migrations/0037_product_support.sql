-- The public record of whether each live module product works today (record/support.ts).
--
-- Lock order: a writer writes `product_support` after the build coverage lock
-- (facts/coverage-lock.ts), guarded by the state it held, and before audit. No account is locked
-- here: followers are told later, by record/followers.ts.

-- Product-scoped: the support state last recorded for a live module product, the channel it is
-- judged on (the product's first, as the public home shows it), and while a drop is open the
-- builds it was recorded on, as session_start.modules holds them: a promotion covering those
-- clears it. No row: supported.
create table product_support (
    product_id  text primary key,
    channel     text not null,
    supported   boolean not null,
    builds      jsonb,
    changed_at  timestamptz not null,
    check (supported = (builds is null))
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
    -- Failed tries at telling the next batch; the fifth gives the row up (record/followers.ts).
    attempts          integer not null default 0 check (attempts between 0 and 5),
    -- A rise tells nobody: it is written as done.
    check (not supported or notified_at is not null)
);

create index product_support_change_product_idx on product_support_change (product_id, id desc);
create index product_support_change_pending_idx on product_support_change (id)
    where notified_at is null;
