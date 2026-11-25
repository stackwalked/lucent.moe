-- The Discord connector: which Discord user each account is, the codes that link them, the rules
-- staff set for the guild, and what the connector has posted to feed channels. The connector
-- holds no credentials; it reads and writes these only through the discord procedures.

-- Global. One Discord user per account and one account per Discord user. Deleting the row is
-- unlinking: the connector removes the synced roles at its next tick, from the audit row.
create table connector_discord_link (
    account_id       text primary key references account (id) on delete cascade,
    discord_user_id  text not null unique check (discord_user_id ~ '^[1-9][0-9]{16,19}$'),
    linked_at        timestamptz not null
);

-- Global. The one-time code a signed-in member gives to /link, by its SHA-256: ten minutes,
-- single use, one per account (asking again replaces it). A used code stays until the next one,
-- so redeeming it again is refused rather than unknown.
create table connector_discord_link_code (
    account_id  text primary key references account (id) on delete cascade,
    code_hash   bytea not null unique check (length(code_hash) = 32),
    expires_at  timestamptz not null,
    used_at     timestamptz
);

-- Global: the connector serves one guild. A role rule may name a product or a site role in its
-- condition (discord/roles.rules.ts); the rule itself belongs to the guild. `discord_id` is the
-- role for a role rule and the channel otherwise.
create table connector_discord_rule (
    id          uuid primary key default gen_random_uuid(),
    kind        text not null check (kind in ('role', 'staff_channel', 'feed')),
    discord_id  text not null check (discord_id ~ '^[1-9][0-9]{16,19}$'),
    condition   jsonb,
    feed        text check (feed in ('status', 'resources', 'releases')),
    created_at  timestamptz not null,
    constraint connector_discord_rule_shape check (
        (kind = 'role') = (condition is not null) and (kind = 'feed') = (feed is not null)
    ),
    constraint connector_discord_rule_once unique nulls not distinct (kind, discord_id, condition, feed)
);

-- Global, through its rule. What a feed channel was told about a subject (a product, a resource,
-- a promotion), so a restarted connector neither repeats a post nor skips one. A status that
-- goes back to one said before is posted again; its row is reused.
create table connector_discord_post (
    rule_id     uuid not null references connector_discord_rule (id) on delete cascade,
    subject     text not null check (length(subject) between 1 and 200),
    state       text not null check (length(state) between 1 and 200),
    message_id  text not null check (message_id ~ '^[1-9][0-9]{16,19}$'),
    posted_at   timestamptz not null,
    primary key (rule_id, subject, state)
);

create index connector_discord_post_latest_idx on connector_discord_post (rule_id, subject, posted_at desc);
