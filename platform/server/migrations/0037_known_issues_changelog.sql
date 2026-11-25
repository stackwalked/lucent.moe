-- What staff tell the public about a product, or about the service when `product_id` is null:
-- known issues and changelog entries (record/notes.ts). Plain text, bounded here as in the
-- contract. Who wrote each change is in the audit, so no row names an account. A row for a
-- product the public home does not list is never read publicly.

-- Product-scoped, or global (null product): a problem staff know of. Open until closed; a closed
-- one stays for staff and is no longer shown publicly.
create table known_issue (
    id          uuid primary key default gen_random_uuid(),
    product_id  text,
    title       text not null check (char_length(title) between 1 and 120),
    body        text not null check (char_length(body) <= 2000),
    opened_at   timestamptz not null,
    updated_at  timestamptz not null,
    closed_at   timestamptz
);

create index known_issue_open_idx on known_issue (opened_at desc) where closed_at is null;

-- Product-scoped, or global (null product): one changelog entry.
create table changelog_entry (
    id            uuid primary key default gen_random_uuid(),
    product_id    text,
    title         text not null check (char_length(title) between 1 and 120),
    body          text not null check (char_length(body) <= 4000),
    published_at  timestamptz not null,
    updated_at    timestamptz not null
);

create index changelog_entry_recent_idx on changelog_entry (published_at desc, id desc);
create index changelog_entry_product_idx on changelog_entry (product_id, published_at desc, id desc);
