-- Global per account: a block belongs to the blocker and is a fact between two accounts, not a
-- product. Neither side sees the other's writing or profile (reads filter both directions); the
-- blocked account is never told. Rows are deleted by unblocking, not by moderators.
create table account_block (
    blocker_id text not null references account (id),
    blocked_id text not null references account (id),
    created_at timestamptz not null default now(),
    primary key (blocker_id, blocked_id),
    check (blocker_id <> blocked_id)
);

create index account_block_blocked on account_block (blocked_id, blocker_id);

-- Global: who may open the profile page. members: any signed-in member; private: only its owner.
-- A profile row is optional, so setting visibility creates one with an empty bio.
alter table profile add column visibility text not null default 'members' check (visibility in ('members', 'private'));
