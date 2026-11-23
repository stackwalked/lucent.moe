-- Scoped per row: product_id null restricts posting everywhere, a product id only there. This is
-- community standing and nothing else: no licence code (status, entitlements, sessions, leases)
-- reads or writes it, and writing it never touches them. A row ends when lifted_at is set, by
-- staff (lifted_by) or by the expiry job at ends_at (lifted_by null); the posting decision also
-- compares ends_at against the transaction's now(), so a late job never extends a restriction.
create table community_restriction (
    id uuid primary key default gen_random_uuid(),
    account_id text not null references account (id),
    kind text not null check (kind in ('muted', 'barred')),
    product_id text check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    reason text not null check (length(reason) between 1 and 500),
    set_by text not null references account (id),
    created_at timestamptz not null default now(),
    ends_at timestamptz,
    lifted_at timestamptz,
    lifted_by text references account (id),
    check (ends_at is null or ends_at > created_at),
    check (lifted_by is null or lifted_at is not null)
);

create index community_restriction_account on community_restriction (account_id) where lifted_at is null;
create index community_restriction_expiring on community_restriction (ends_at) where lifted_at is null and ends_at is not null;
create index community_restriction_page on community_restriction (created_at desc, id desc) where lifted_at is null;
