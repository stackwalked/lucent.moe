alter table account add column reset_lock boolean not null default false,
    add column sign_in_cutoff timestamptz;
-- Discoverable passkey flows have no owner until the assertion names one.
alter table auth_flow add column created_at timestamptz not null default now();

-- Global account credential, not product-scoped. One live link per account, never the bearer.
create table password_reset (
    token_hash bytea primary key check (length(token_hash) = 32),
    account_id text not null unique references account(id) on delete cascade,
    expires_at timestamptz not null
);
create index password_reset_expiry on password_reset(expires_at);
-- Removing the link also discards its queued plaintext, including when mail is disabled.
alter table mail_outbox add column reset_hash bytea references password_reset(token_hash) on delete cascade;
create index mail_outbox_reset on mail_outbox(reset_hash) where reset_hash is not null;
