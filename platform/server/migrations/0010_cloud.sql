-- Per account and product: the lock exists even when the last item has been removed.
create table cloud_scope (
    account_id text not null references account (id) on delete cascade,
    product_id text not null,
    primary key (account_id, product_id)
);

-- Per account and product. Identity is assigned by the server, not by a device.
create table cloud_item (
    account_id text not null,
    product_id text not null,
    item_id bigint generated always as identity,
    kind text not null check (kind in ('config', 'inventory', 'script')),
    primary key (account_id, product_id, item_id),
    foreign key (account_id, product_id) references cloud_scope on delete cascade
);

-- Per account and product. Highest revision wins; the name is part of the snapshot.
create table cloud_version (
    account_id text not null,
    product_id text not null,
    item_id bigint not null,
    revision integer not null check (revision > 0),
    name text not null,
    bytes bytea not null,
    primary key (account_id, product_id, item_id, revision),
    foreign key (account_id, product_id, item_id) references cloud_item on delete cascade
);

create function protect_cloud_version() returns trigger language plpgsql as $$
begin
    if tg_op = 'UPDATE' or exists (
        select 1 from cloud_item where (account_id, product_id, item_id) =
            (old.account_id, old.product_id, old.item_id)
    ) then
        raise exception 'cloud versions are immutable while the item exists'
            using errcode = 'check_violation', constraint = 'cloud_version_immutable';
    end if;
    return old;
end;
$$;

create trigger cloud_version_immutable before update or delete on cloud_version
    for each row execute function protect_cloud_version();

-- Per owner and product. Only the digest is searchable; a link grants one fixed snapshot.
create table cloud_share (
    account_id text not null,
    product_id text not null,
    item_id bigint not null,
    revision integer not null,
    share_id bigint generated always as identity,
    token_hash bytea not null unique check (octet_length(token_hash) = 32),
    primary key (account_id, product_id, share_id),
    foreign key (account_id, product_id, item_id, revision) references cloud_version on delete cascade
);

create index cloud_share_snapshot_idx on cloud_share (account_id, product_id, item_id, revision);
