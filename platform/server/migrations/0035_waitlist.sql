-- The waitlist's applications. Lock order: the reviewing staff account before an application row.
-- An approval mails the setup link as a redeemed invite does (0034's 'setup' outbox kind).

-- Global: an application to the waitlist, as the public form took it. Unlike the invite edge this
-- is personal data: an address, what the applicant wrote, a Discord handle and the username of a
-- member they say knows them, both as typed, verified against nothing and linked to nothing.
-- `account_id` is the account an approval created.
create table application (
    id          bigint generated always as identity primary key,
    email       text not null check (email = lower(email) and length(email) <= 254),
    products    text[] not null check (cardinality(products) between 1 and 16),
    about       text not null check (length(about) between 1 and 2000),
    discord     text check (length(discord) between 1 and 64),
    known_by    text check (length(known_by) between 1 and 64),
    state       text not null default 'pending'
                check (state in ('pending', 'approved', 'declined')),
    created_at  timestamptz not null,
    decided_at  timestamptz,
    decided_by  text references account (id),
    account_id  text unique references account (id),
    check ((state = 'pending') = (decided_at is null)),
    check ((state = 'pending') = (decided_by is null)),
    check ((state = 'approved') = (account_id is not null))
);

-- One open application per address: submitting again while one waits changes nothing.
create unique index application_pending_email_idx on application (email) where state = 'pending';
create index application_email_idx on application (email, id desc);
create index application_state_idx on application (state, id desc);
