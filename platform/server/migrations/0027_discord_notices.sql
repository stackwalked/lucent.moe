-- Notices on Discord: a linked member may also get a direct message when a notice arrives. It
-- says that something happened and links to the inbox; a security notice's DM never carries its
-- content. Security stays on in the inbox and by mail; Discord is the one switch a member has
-- there, so a security row's inbox and mail are stored on and never read.
alter table notification_preference add column discord boolean not null default false;
alter table notification_preference drop constraint notification_preference_kind_check;
alter table notification_preference
    add constraint notification_preference_kind_check check (kind in ('product_status', 'security'));

-- Global per account: a notice waiting to go out as a DM, written in the notice's transaction. It
-- holds the kind and the product and nothing else. The connector reads due rows and settles each:
-- sent, or refused by Discord (DMs closed, the bot blocked), removes it; any other failure puts it
-- back until its attempts run out (discord/dms.rules.ts). The inbox entry never depends on it.
create table connector_discord_dm (
    id               bigint generated always as identity primary key,
    account_id       text not null references account (id) on delete cascade,
    kind             text not null check (kind in ('security', 'product_status')),
    product_id       text check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    attempts         integer not null default 0 check (attempts >= 0),
    next_attempt_at  timestamptz not null,
    created_at       timestamptz not null,
    check ((kind = 'product_status') = (product_id is not null))
);

create index connector_discord_dm_due_idx on connector_discord_dm (next_attempt_at, id);
