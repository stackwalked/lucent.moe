-- Product-scoped: a member's offer of one of their cloud items, to every member who holds the
-- product. Like a share it pins a snapshot by revision into cloud_version, so no content is
-- copied and the item's version window keeps the pinned revisions. `revision` is the snapshot
-- others see; `pending_revision` is a script's newer snapshot waiting for staff, while the
-- last approved one stays visible. A first-time script is `pending` with no visible snapshot.
-- A removed listing keeps its row (reports and the audit trail point at it) but pins nothing.
-- Deleting the owner's item deletes its listing; copies keep their content and lose their source.
create table cloud_listing (
    id               uuid primary key default gen_random_uuid(),
    owner_id         text not null references account (id),
    product_id       text not null,
    kind             text not null check (kind in ('config', 'inventory', 'script')),
    item_id          bigint not null,
    revision         integer,
    pending_revision integer,
    name             text not null check (length(name) between 1 and 60),
    summary          text not null check (length(summary) <= 140 and summary !~ '[\r\n]'),
    state            text not null check (state in ('pending', 'listed', 'removed')),
    listed_at        timestamptz,
    updated_at       timestamptz not null default now(),
    removed_at       timestamptz,
    removed_by       text references account (id),
    foreign key (owner_id, product_id, item_id) references cloud_item on delete cascade,
    foreign key (owner_id, product_id, item_id, revision) references cloud_version on delete cascade,
    foreign key (owner_id, product_id, item_id, pending_revision) references cloud_version on delete cascade,
    check ((state = 'listed') = (revision is not null)),
    check (state <> 'pending' or pending_revision is not null),
    check (state <> 'removed' or (revision is null and pending_revision is null)),
    check ((state = 'removed') = (removed_at is not null)),
    check (removed_by is null or removed_at is not null)
);

-- One live listing per item.
create unique index cloud_listing_live on cloud_listing (owner_id, product_id, item_id)
    where state <> 'removed';
create index cloud_listing_page on cloud_listing (product_id, updated_at desc, id desc)
    where state = 'listed';
create index cloud_listing_owner on cloud_listing (owner_id, product_id);
create index cloud_listing_pending on cloud_listing (updated_at, id)
    where state <> 'removed' and pending_revision is not null;
create index cloud_listing_revision on cloud_listing (owner_id, product_id, item_id, revision);
create index cloud_listing_pending_revision
    on cloud_listing (owner_id, product_id, item_id, pending_revision);

-- Where a copy came from; the copy is an ordinary item and does not follow the listing.
alter table cloud_item add column source_listing_id uuid references cloud_listing (id)
    on delete set null;
create index cloud_item_source on cloud_item (source_listing_id) where source_listing_id is not null;

alter table report drop constraint report_target_kind_check;
alter table report add constraint report_target_kind_check
    check (target_kind in ('comment', 'shout', 'guide', 'profile', 'listing'));
