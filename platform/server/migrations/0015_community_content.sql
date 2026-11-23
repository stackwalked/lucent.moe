-- Global: a profile belongs to one account whatever the product; no row means an empty bio.
create table profile (
    account_id text primary key references account (id),
    bio text not null check (length(bio) <= 500),
    updated_at timestamptz not null default now()
);

-- Product-scoped: a guide belongs to exactly one product, and only members who may see that
-- product read it. Nothing is hard-deleted by a moderator: removal sets removed_at, and every
-- read filters it.
create table guide (
    id uuid primary key default gen_random_uuid(),
    product_id text not null check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    author_id text not null references account (id),
    title text not null check (length(title) between 1 and 120),
    body text not null check (length(body) between 1 and 20000),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    removed_at timestamptz,
    removed_by text references account (id),
    check (removed_by is null or removed_at is not null)
);

create index guide_product_page on guide (product_id, created_at desc, id desc) where removed_at is null;
create index guide_author on guide (author_id);

-- Product-scoped by inheritance: a comment has no product of its own, it takes its guide's, so
-- the two can never disagree. Removal as for guides.
create table comment (
    id uuid primary key default gen_random_uuid(),
    guide_id uuid not null references guide (id),
    author_id text not null references account (id),
    body text not null check (length(body) between 1 and 2000),
    created_at timestamptz not null default now(),
    removed_at timestamptz,
    removed_by text references account (id),
    check (removed_by is null or removed_at is not null)
);

create index comment_page on comment (guide_id, created_at, id) where removed_at is null;
create index comment_author on comment (author_id);

-- Global feed whose entries may name a product (product_id null: not about any one). Reads of the
-- whole feed show only entries about products the reader may see. Removal as for guides.
create table shout (
    id uuid primary key default gen_random_uuid(),
    author_id text not null references account (id),
    product_id text check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    body text not null check (length(body) between 1 and 280),
    created_at timestamptz not null default now(),
    removed_at timestamptz,
    removed_by text references account (id),
    check (removed_by is null or removed_at is not null)
);

create index shout_page on shout (created_at desc, id desc) where removed_at is null;
create index shout_product_page on shout (product_id, created_at desc, id desc) where removed_at is null and product_id is not null;
create index shout_author on shout (author_id);
