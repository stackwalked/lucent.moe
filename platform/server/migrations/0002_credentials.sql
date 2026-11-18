-- Credentials, browser sessions and the short-lived state between them. Every secret a browser
-- holds (session, flow and setup tokens) is stored as its SHA-256 only.

create table passkey (
    id              bytea primary key,
    account_id      text not null references account (id) on delete cascade,
    public_key      bytea not null,
    sign_count      bigint not null check (sign_count >= 0),
    transports      text[] not null default '{}',
    backed_up       boolean not null,
    label           text not null check (length(label) between 1 and 64),
    created_at      timestamptz not null,
    last_used_at    timestamptz
);

create index passkey_account_idx on passkey (account_id);

create table password_credential (
    account_id  text primary key references account (id) on delete cascade,
    hash        text not null,
    updated_at  timestamptz not null
);

-- The secret is AES-256-GCM under `key_id`, bound to the account. `last_used_step` only grows:
-- a code is accepted once, and never one older than the last accepted.
create table totp_credential (
    account_id      text primary key references account (id) on delete cascade,
    key_id          text not null,
    secret_sealed   bytea not null,
    confirmed       boolean not null default false,
    last_used_step  bigint not null default 0,
    created_at      timestamptz not null
);

create table browser_session (
    token_hash        bytea primary key check (length(token_hash) = 32),
    account_id        text not null references account (id) on delete cascade,
    purpose           text not null check (purpose in ('member', 'setup')),
    created_at        timestamptz not null,
    expires_at        timestamptz not null,
    authenticated_at  timestamptz not null,
    step_up_at        timestamptz,
    constraint browser_session_window check (expires_at > created_at)
);

create index browser_session_account_idx on browser_session (account_id);

-- A sign-in, step-up or passkey registration in progress. `account_id` is null only for a
-- passkey sign-in that hasn't yet presented a credential.
create table auth_flow (
    token_hash      bytea primary key check (length(token_hash) = 32),
    kind            text not null check (kind in ('sign_in', 'step_up', 'register')),
    account_id      text references account (id) on delete cascade,
    session_hash    bytea references browser_session (token_hash) on delete cascade,
    password_ok     boolean not null default false,
    challenge       bytea,
    failures        integer not null default 0 check (failures >= 0),
    expires_at      timestamptz not null,
    constraint auth_flow_owner check (kind = 'sign_in' or (account_id is not null and session_hash is not null))
);

create table setup_token (
    token_hash  bytea primary key check (length(token_hash) = 32),
    account_id  text not null references account (id) on delete cascade,
    issued_by   text not null,
    created_at  timestamptz not null,
    expires_at  timestamptz not null
);

create index setup_token_account_idx on setup_token (account_id);
