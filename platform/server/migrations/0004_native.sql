-- The native path: releases a start needs, the loader's sign-in (pushed auth requests, PKCE and
-- DPoP-bound tokens), devices and their enrollment, product slots, starts, runtime sessions and
-- their leases. Ids the native wire carries are 16 random bytes; every secret a loader holds is
-- stored as its SHA-256 only. A device key is named by its RFC 7638 thumbprint (`jkt`).

-- A release as `ops publish-release` will write it; until then tests insert rows directly. The
-- seal and container are opaque here: their formats live in contracts/ once defined. A loader
-- release has neither container nor manifest.
create table release (
    id          bytea primary key check (length(id) = 16),
    product_id  text not null,
    channel     text not null,
    seal        bytea not null check (length(seal) between 1 and 1048576),
    container   bytea,
    manifest    bytea,
    created_at  timestamptz not null default now(),
    constraint release_module_parts check ((container is null) = (manifest is null))
);

-- One current release per product and channel; promotion replaces the row. A replaced release
-- stays in `release`, servable to the sessions still running on it.
create table current_release (
    product_id   text not null,
    channel      text not null,
    release_id   bytea not null references release (id),
    promoted_at  timestamptz not null default now(),
    primary key (product_id, channel)
);

-- A loader's pushed authorization request, from POST /v1/auth/requests until its code is
-- redeemed. Bound to the device key that pushed it: only that key redeems the code.
create table native_auth_request (
    id               text primary key check (id ~ '^lauth_[A-Za-z0-9_-]{22}$'),
    jkt              text not null,
    redirect_uri     text not null,
    code_challenge   text not null,
    state            text not null,
    created_at       timestamptz not null,
    expires_at       timestamptz not null,
    account_id       text references account (id) on delete cascade,
    decision         text check (decision in ('approved', 'denied')),
    code_hash        bytea unique check (length(code_hash) = 32),
    code_expires_at  timestamptz,
    redeemed_at      timestamptz,
    family_id        bytea,
    constraint native_auth_request_decided check ((decision is null) = (account_id is null)),
    constraint native_auth_request_code check (
        (code_hash is null) = (code_expires_at is null)
        and (code_hash is null or decision = 'approved')
    )
);

-- One sign-in of one loader: every refresh token rotated from the first, and the access tokens
-- they minted. Revoking the family ends all of them at once.
create table native_token_family (
    id          bytea primary key check (length(id) = 16),
    account_id  text not null references account (id) on delete cascade,
    jkt         text not null,
    created_at  timestamptz not null,
    revoked_at  timestamptz
);

create index native_token_family_account_idx on native_token_family (account_id);

-- A family has one live refresh token: the newest. `parent_hash` names the token it rotated
-- from, so a retry within the grace can tell its own successor from a later one.
create table native_refresh_token (
    token_hash   bytea primary key check (length(token_hash) = 32),
    family_id    bytea not null references native_token_family (id) on delete cascade,
    parent_hash  bytea,
    issued_at    timestamptz not null,
    expires_at   timestamptz not null,
    rotated_at   timestamptz
);

create unique index native_refresh_token_live_idx on native_refresh_token (family_id)
    where rotated_at is null;

create table native_access_token (
    token_hash  bytea primary key check (length(token_hash) = 32),
    family_id   bytea not null references native_token_family (id) on delete cascade,
    expires_at  timestamptz not null
);

-- DPoP proofs seen, kept until their `iat` leaves the freshness window and they'd be refused
-- anyway.
create table dpop_proof (
    jkt         text not null,
    jti         text not null,
    expires_at  timestamptz not null,
    primary key (jkt, jti)
);

create table device (
    id           bytea primary key check (length(id) = 16),
    account_id   text not null references account (id) on delete cascade,
    jkt          text not null,
    public_key   jsonb not null,
    storage      text not null check (storage in ('tpm', 'software')),
    enrolled_at  timestamptz not null,
    revoked_at   timestamptz
);

create index device_account_idx on device (account_id);
create unique index device_live_key_idx on device (jkt) where revoked_at is null;

-- When the account last replaced a device itself; the next self-service replacement waits
-- seven days from it.
create table device_change_window (
    account_id        text primary key references account (id) on delete cascade,
    last_replaced_at  timestamptz not null
);

-- A candidate device key waiting for its owner to confirm it in the browser. A pending row past
-- `expires_at` reads as expired; the next request for the same key marks it so.
create table device_enrollment (
    id          bytea primary key check (length(id) = 16),
    account_id  text not null references account (id) on delete cascade,
    jkt         text not null,
    public_key  jsonb not null,
    storage     text not null check (storage in ('tpm', 'software')),
    created_at  timestamptz not null,
    expires_at  timestamptz not null,
    state       text not null default 'pending'
        check (state in ('pending', 'approved', 'denied', 'expired')),
    device_id   bytea references device (id),
    decided_at  timestamptz,
    constraint device_enrollment_device check ((state = 'approved') = (device_id is not null))
);

create unique index device_enrollment_pending_idx on device_enrollment (account_id, jkt)
    where state = 'pending';

-- Serializes sessions per account and product: the newest session takes the slot by bumping
-- the generation, and a session whose generation is no longer the slot's is refused at its next
-- renewal. `holder_session` is null once its holder closed.
create table product_slot (
    account_id      text not null references account (id) on delete cascade,
    product_id      text not null,
    generation      bigint not null default 0 check (generation >= 0),
    holder_session  bytea,
    primary key (account_id, product_id)
);

-- What POST /v1/starts checked and handed out, until the module's hello consumes it. The
-- container key is wiped when the start is consumed.
create table session_start (
    id             bytea primary key check (length(id) = 16),
    account_id     text not null references account (id) on delete cascade,
    device_id      bytea not null references device (id),
    product_id     text not null,
    channel        text not null,
    release_id     bytea not null references release (id),
    container_key  bytea check (length(container_key) = 32),
    created_at     timestamptz not null,
    expires_at     timestamptz not null,
    consumed_at    timestamptz
);

create index session_start_account_idx on session_start (account_id);

-- A module's session and the lease it holds. The lease fields are the current lease's, enough to
-- sign it again for a retried request. Frame sequences are u64 on the wire, so numeric here.
create table runtime_session (
    id                      bytea primary key check (length(id) = 16),
    start_id                bytea not null unique references session_start (id),
    account_id              text not null references account (id) on delete cascade,
    device_id               bytea not null references device (id),
    product_id              text not null,
    channel                 text not null,
    release_id              bytea not null references release (id),
    slot_generation         bigint not null,
    module_key              bytea not null check (length(module_key) = 32),
    server_key              bytea not null check (length(server_key) = 32),
    key_to_server           bytea check (length(key_to_server) = 32),
    key_to_module           bytea check (length(key_to_module) = 32),
    boot_info_version       bigint not null,
    image_kind              text not null check (image_kind in ('loaded', 'mapped')),
    image_base              numeric(20, 0) not null,
    image_size              bigint not null,
    entitled_everything     boolean not null,
    entitled_features       numeric(20, 0)[] not null,
    created_at              timestamptz not null,
    lease_sequence          bigint not null check (lease_sequence >= 1),
    lease_nonce             bytea not null check (length(lease_nonce) = 16),
    lease_challenge_nonce   bytea not null check (length(lease_challenge_nonce) = 16),
    lease_challenge_offset  bigint not null,
    lease_challenge_size    bigint not null,
    loader_challenge_nonce  bytea not null check (length(loader_challenge_nonce) = 16),
    loader_challenge_offset bigint not null,
    loader_challenge_size   bigint not null,
    lease_issued_at         timestamptz not null,
    lease_expires_at        timestamptz not null,
    frame_in_sequence       numeric(20, 0) not null,
    frame_out_sequence      numeric(20, 0) not null,
    ended_at                timestamptz,
    end_reason              text check (end_reason in
        ('closed', 'slot_taken', 'suspended', 'device_revoked', 'expired', 'capped')),
    constraint runtime_session_ended check ((ended_at is null) = (end_reason is null))
);

create index runtime_session_account_idx on runtime_session (account_id);

-- Each renewal's reports, stored as received: signal bits are assigned in slice 3, and the
-- challenge answers are checked once the server has a copy of the image to hash.
create table lease_renewal (
    session_id     bytea not null references runtime_session (id) on delete cascade,
    sequence       bigint not null,
    received_at    timestamptz not null,
    signals        bytea not null check (length(signals) = 64),
    module_answer  bytea not null check (length(module_answer) = 32),
    loader_answer  bytea check (length(loader_answer) = 32),
    primary key (session_id, sequence)
);
