-- Global per account: channel choices apply across followed products. Security is not mutable.
create table notification_preference (
    account_id text not null references account (id) on delete cascade,
    kind text not null check (kind in ('product_status')),
    inbox boolean not null,
    mail boolean not null,
    primary key (account_id, kind)
);

-- Product-scoped: a follow belongs only to the subscribing account.
create table product_subscription (
    account_id text not null references account (id) on delete cascade,
    product_id text not null check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    primary key (account_id, product_id)
);

create index product_subscription_followers on product_subscription (product_id, account_id);

-- Global per-account inbox page; product_status entries additionally identify their product.
-- No free-form payload: an inbox entry can never carry a credential or reset link.
create table inbox_entry (
    id uuid primary key default gen_random_uuid(),
    account_id text not null references account (id) on delete cascade,
    kind text not null check (kind in ('security', 'product_status')),
    product_id text check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    created_at timestamptz not null default now(),
    is_read boolean not null default false,
    check ((kind = 'product_status') = (product_id is not null))
);

create index inbox_entry_page on inbox_entry (account_id, created_at desc, id desc);
create index inbox_entry_unread on inbox_entry (account_id) where not is_read;
create index inbox_entry_products on inbox_entry (account_id, product_id) where product_id is not null;
