-- Account deletion: a member asks, seven days pass (deletion/deletion.rules.ts), and the account is
-- stripped to a tombstone (deletion/strip.ts). The row stays so audit rows, invite edges and staff
-- records keep pointing at an id; everything that was the person goes.

-- Global, on the account row. A deletion is its own fact beside `status`, never a third status:
-- a suspended account may delete, and staff (and admission) must still see that it was suspended.
-- Pending: requested_at and due_at both set, the account working as before. Completed: deleted_at
-- set and the request cleared. A tombstone has no address and no username; when it was suspended
-- it keeps `email_hash`, an HMAC of the address under a key derived from a server secret
-- (deletion/email-hash.ts), which only recognises that address applying again.
alter table account
    add column deletion_requested_at timestamptz,
    add column deletion_due_at timestamptz,
    add column deleted_at timestamptz,
    add column email_hash bytea check (email_hash is null or length(email_hash) = 32),
    add column email_hash_kid text,
    alter column email drop not null,
    add constraint account_deletion_request check (
        (deletion_requested_at is null) = (deletion_due_at is null)
        and (deletion_due_at is null or deletion_due_at > deletion_requested_at)
        and (deleted_at is null or deletion_requested_at is null)
    ),
    add constraint account_tombstone check (
        (deleted_at is null) = (email is not null)
        and (deleted_at is null or username is null)
        and (email_hash is null or deleted_at is not null)
        and ((email_hash is null) = (email_hash_kid is null))
    ),
    add constraint account_root_never_deleted check (
        not is_root or (deleted_at is null and deletion_requested_at is null)
    );

-- The grace-period job's queue.
create index account_deletion_due_idx on account (deletion_due_at) where deletion_due_at is not null;
create index account_email_hash_idx on account (email_hash) where email_hash is not null;

-- Global: the skeletons (authority/usernames.ts) of deleted accounts' usernames, as SHA-256, so the
-- names stay taken for good without a readable name or an account id next to them. Unkeyed on
-- purpose: whether a name is taken is answered to anyone who tries to claim it, so a key would hide
-- nothing a claim attempt doesn't tell. Every claim insert is checked here by the trigger below,
-- and refused as the claim's own unique key would refuse it, so each writer's existing
-- USERNAME_TAKEN mapping covers it.
create table retired_username (
    skeleton_digest  bytea primary key check (length(skeleton_digest) = 32)
);

create function refuse_retired_username() returns trigger language plpgsql as $$
begin
    if exists (select 1 from retired_username
               where skeleton_digest = sha256(convert_to(new.skeleton, 'UTF8'))) then
        raise exception 'username is retired'
            using errcode = 'unique_violation', constraint = 'username_retired';
    end if;
    return new;
end;
$$;

create trigger username_claim_not_retired_trg
    before insert or update of skeleton on username_claim
    for each row execute function refuse_retired_username();

-- Global, per application: the tombstone of a suspended account whose address this application
-- named, so staff see who is applying again. Set by the public form only; the applicant hears the
-- same either way.
alter table application add column returning_account_id text references account (id);

-- Global, through its ticket: a deleted member's own messages are kept 30 days after deletion and
-- then removed with the ticket's subject (jobs/retention.ts); staff replies stay. A help ticket
-- has a subject until then.
alter table ticket add column owner_text_removed_at timestamptz;
alter table ticket drop constraint ticket_kind_shape;
alter table ticket add constraint ticket_kind_shape check (
    (kind = 'help' or (subject is null and product_id is null))
    and (kind = 'appeal' or subject is not null or owner_text_removed_at is not null)
);
