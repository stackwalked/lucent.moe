-- A member is told before an entitlement of theirs ends. What the job recorded is the only memory
-- of it: one row per entitlement, end date and mark, so a run (or a second instance) that finds the
-- row does nothing, and an entitlement extended to a new end date is told again for that date.
create table subscription_ending_notice (
    entitlement_id text not null references entitlement (id) on delete cascade,
    valid_until    timestamptz not null,
    mark           text not null check (mark in ('7d', '1d')),
    recorded_at    timestamptz not null default now(),
    primary key (entitlement_id, valid_until, mark)
);

-- The notice itself: an inbox entry naming the product and the end. The product is kept so the
-- reader can be told which, and left out of what the inbox returns once the member may no longer
-- see it (notify/inbox.ts).
alter table inbox_entry add column ends_at timestamptz;
alter table inbox_entry drop constraint inbox_entry_kind_check;
alter table inbox_entry drop constraint inbox_entry_subject_check;
alter table inbox_entry
    add constraint inbox_entry_kind_check
    check (kind in ('security', 'product_status', 'ticket_reply', 'subscription_ending'));
alter table inbox_entry
    add constraint inbox_entry_subject_check
    check ((kind in ('product_status', 'subscription_ending')) = (product_id is not null)
       and (kind = 'ticket_reply') = (ticket_id is not null)
       and (kind = 'subscription_ending') = (ends_at is not null));

-- And its Discord DM, which names the product only if the member could see it when it was
-- queued (product_id null otherwise).
alter table connector_discord_dm add column ends_at timestamptz;
alter table connector_discord_dm drop constraint connector_discord_dm_kind_check;
alter table connector_discord_dm drop constraint connector_discord_dm_check;
alter table connector_discord_dm
    add constraint connector_discord_dm_kind_check
    check (kind in ('security', 'product_status', 'subscription_ending'));
alter table connector_discord_dm
    add constraint connector_discord_dm_subject_check
    check ((kind <> 'product_status' or product_id is not null)
       and (kind <> 'security' or product_id is null)
       and (kind = 'subscription_ending') = (ends_at is not null));
