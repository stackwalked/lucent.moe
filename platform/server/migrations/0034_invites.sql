-- Invites: what staff let a member spend on them, and the invites (a redeemed one is an edge of the
-- invite tree).
--
-- Lock order: the inviter's account row before any of their invite rows. Every invite writer locks
-- the inviter first, which serializes all of one inviter's invites and their allowance behind one
-- row.

-- Global, per account: how many invites staff let the account issue in all, zero when there is no
-- row. What it has spent is counted from its invite rows (redeemed, or unused and unexpired), never
-- stored, so the two cannot drift. An account id and a number: account deletion keeps it.
create table invite_allowance (
    account_id  text primary key references account (id),
    granted     integer not null check (granted between 0 and 1000),
    updated_at  timestamptz not null
);

-- Global: an invite a member issued. Single use, for seven days, and it creates an account and
-- nothing else. The token's SHA-256 is kept only while the invite may still be redeemed. A
-- redeemed invite is the tree's edge inviter -> invitee: account ids and times, no personal data,
-- so account deletion keeps it. An account has at most one inviter.
create table invite (
    id           bigint generated always as identity primary key,
    inviter_id   text not null references account (id),
    token_hash   bytea unique check (length(token_hash) = 32),
    created_at   timestamptz not null,
    expires_at   timestamptz not null check (expires_at > created_at),
    revoked_at   timestamptz,
    redeemed_at  timestamptz,
    invitee_id   text unique references account (id),
    check ((redeemed_at is null) = (invitee_id is null)),
    check (revoked_at is null or redeemed_at is null),
    check ((token_hash is null) = (revoked_at is not null or redeemed_at is not null))
);

create index invite_inviter_idx on invite (inviter_id, id desc);

-- A redeemed invite mails the new account's setup link. Like a reset mail the row carries a bearer,
-- which dies with the link (72 hours, single use, replaced by a recovery); settling erases the text.
alter table mail_outbox drop constraint mail_outbox_kind_check;
alter table mail_outbox
    add constraint mail_outbox_kind_check check (kind in ('notice', 'reset', 'setup'));
