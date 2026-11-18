-- Authority: accounts, username claims, roles, entitlements, audit and receipts.

create table service (
    id      boolean primary key default true check (id),
    epoch   bigint not null default 1 check (epoch >= 1)
);

insert into service (id, epoch) values (true, 1);

create table account (
    id          text primary key,
    email       text not null unique check (email = lower(email)),
    username    text unique check (username is null or username = lower(username)),
    status      text not null default 'active' check (status in ('active', 'suspended')),
    is_root     boolean not null default false,
    is_locked   boolean not null default false,
    created_at  timestamptz not null default now(),
    constraint account_root_inviolable check (not is_root or (status = 'active' and not is_locked))
);

create unique index account_single_root_idx on account (is_root) where is_root;

-- Root is set once, at bootstrap. Handing it over is `ops transfer-superadmin`'s job and will
-- arrive with that verb; until then no update may grant or revoke it.
create function enforce_root_permanence() returns trigger language plpgsql as $$
begin
    if new.is_root is distinct from old.is_root then
        raise exception 'root is granted only at bootstrap'
            using errcode = 'check_violation', constraint = 'account_root_permanent';
    end if;
    return new;
end;
$$;

create trigger account_root_permanent_trg
    before update of is_root on account
    for each row execute function enforce_root_permanence();

-- A claim outlives the username that made it, so a renamed account's old name (and every
-- look-alike of it) never becomes available again.
create table username_claim (
    skeleton    text primary key,
    username    text not null,
    account_id  text not null references account (id),
    claimed_at  timestamptz not null default now()
);

create function enforce_username_immutability() returns trigger language plpgsql as $$
begin
    if old.username is not null
       and new.username is distinct from old.username
       and coalesce(current_setting('lucent.username_rename', true), '') <> 'on' then
        raise exception 'username is immutable outside explicit admin rename'
            using errcode = 'check_violation', constraint = 'account_username_immutable';
    end if;
    return new;
end;
$$;

create trigger account_username_immutable_trg
    before update of username on account
    for each row execute function enforce_username_immutability();

create table role (
    id              text primary key,
    name            text not null unique,
    rank            integer not null check (rank >= 0),
    permissions     text[] not null default '{}',
    channel_grants  jsonb not null default '[]'::jsonb,
    created_at      timestamptz not null default now()
);

create table account_role (
    account_id  text not null references account (id) on delete cascade,
    role_id     text not null references role (id) on delete cascade,
    granted_at  timestamptz not null default now(),
    expires_at  timestamptz,
    primary key (account_id, role_id)
);

create table entitlement (
    id           text primary key,
    account_id   text not null references account (id) on delete cascade,
    status       text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
    valid_from   timestamptz not null,
    valid_until  timestamptz,
    created_at   timestamptz not null default now(),
    constraint entitlement_window_valid check (valid_until is null or valid_until > valid_from)
);

create index entitlement_account_status_idx on entitlement (account_id, status);

create table entitlement_product (
    entitlement_id  text not null references entitlement (id) on delete cascade,
    product_id      text not null,
    features        jsonb not null,
    channels        text[] not null,
    primary key (entitlement_id, product_id)
);

create table audit (
    id          bigint generated always as identity primary key,
    at          timestamptz not null default now(),
    actor_id    text not null,
    operation   text not null,
    target      jsonb not null default '{}'::jsonb
);

create table receipt (
    principal     text not null,
    endpoint      text not null,
    operation_id  text not null,
    digest        text not null,
    result        jsonb not null,
    created_at    timestamptz not null default now(),
    primary key (principal, endpoint, operation_id)
);
