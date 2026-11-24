-- Support: the appeal session, tickets and appeals with the consent recorded on them, the
-- countries an account signs in from, and the files staff publish for members.

-- A suspended account that passed every factor gets a session of this purpose and nothing else:
-- it reaches the appeal and no member procedure (auth/sessions.ts).
alter table browser_session drop constraint browser_session_purpose_check;
alter table browser_session
    add constraint browser_session_purpose_check check (purpose in ('member', 'setup', 'appeal'));

-- The appeal shows the reason staff gave when suspending, which only the audit row holds.
create index audit_suspension_idx on audit ((target ->> 'accountId'), id desc)
    where operation = 'account.suspend';

-- Global per account: a member's request for help, or a suspended account's appeal. A help
-- ticket may name a product; listing goes by owner, never by product. `state` follows
-- support/tickets.rules.ts: open (waiting on staff), answered (waiting on the member), closed.
-- An account has one appeal thread, with no subject or product; writing to it again reopens it.
create table ticket (
    id                uuid primary key default gen_random_uuid(),
    account_id        text not null references account (id) on delete cascade,
    kind              text not null check (kind in ('help', 'appeal')),
    product_id        text check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    subject           text check (length(subject) between 1 and 120),
    state             text not null check (state in ('open', 'answered', 'closed')),
    opened_at         timestamptz not null,
    last_activity_at  timestamptz not null,
    closed_at         timestamptz,
    constraint ticket_closed check ((state = 'closed') = (closed_at is not null)),
    constraint ticket_kind_shape check (
        (kind = 'help') = (subject is not null) and (kind = 'help' or product_id is null)
    )
);

create unique index ticket_one_appeal_idx on ticket (account_id) where kind = 'appeal';
create index ticket_owner_page_idx on ticket (account_id, last_activity_at desc, id desc);
create index ticket_queue_idx on ticket (state, last_activity_at, id);

-- Global, through its ticket: the thread. Append-only; `from_staff` is who the member sees
-- answering, whichever staff account wrote it.
create table ticket_message (
    id          bigint generated always as identity primary key,
    ticket_id   uuid not null references ticket (id) on delete cascade,
    author_id   text not null references account (id),
    from_staff  boolean not null,
    body        text not null check (length(body) between 1 and 4000),
    created_at  timestamptz not null
);

create index ticket_message_thread_idx on ticket_message (ticket_id, id);

-- Global, through its ticket: the member allowing or withdrawing support's reading of their
-- configs for that ticket. Append-only, so the record says who allowed what when; the latest row
-- is the current answer, and a closed ticket allows nothing whatever it says.
create table ticket_consent (
    id          bigint generated always as identity primary key,
    ticket_id   uuid not null references ticket (id) on delete cascade,
    account_id  text not null references account (id) on delete cascade,
    scope       text not null check (scope in ('config')),
    granted     boolean not null,
    at          timestamptz not null
);

create index ticket_consent_latest_idx on ticket_consent (ticket_id, scope, id desc);

-- Global per account: a member sign-in waiting for the country check. Every member session is
-- observed when it is created, whichever path minted it, so a new path can't skip the check;
-- the sign-in-countries job reads, judges and deletes these.
create table sign_in_observation (
    id           bigint generated always as identity primary key,
    account_id   text not null references account (id) on delete cascade,
    client_ip    inet not null,
    observed_at  timestamptz not null
);

create function observe_member_sign_in() returns trigger language plpgsql as $$
begin
    insert into sign_in_observation (account_id, client_ip, observed_at)
        values (new.account_id, new.client_ip, new.created_at);
    return new;
end;
$$;

create trigger browser_session_observe_sign_in_trg
    after insert on browser_session
    for each row when (new.purpose = 'member' and new.client_ip is not null)
    execute function observe_member_sign_in();

-- Global per account: each country (ISO 3166-1 alpha-2, from the DB-IP Lite file) the account
-- has signed in from. The first one is learned quietly; a later new one is a risk signal.
create table sign_in_country (
    account_id     text not null references account (id) on delete cascade,
    country        text not null check (country ~ '^[A-Z]{2}$'),
    first_seen_at  timestamptz not null,
    last_seen_at   timestamptz not null,
    primary key (account_id, country)
);

alter table risk_signal drop constraint risk_signal_kind_check;
alter table risk_signal
    add constraint risk_signal_kind_check
    check (kind in ('loader_silent', 'software_device_key', 'new_country'));

-- Global, or product-scoped when `product_id` is set: a file staff publish. One naming a product
-- lists and downloads only for members entitled to it; one naming none, for every member. The
-- bytes sit in ARTIFACT_DIR under their BLAKE2b-256 digest, as ops publish-loader keeps its own.
create table resource (
    id            uuid primary key default gen_random_uuid(),
    product_id    text check (product_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
    title         text not null check (length(title) between 1 and 120),
    description   text not null check (length(description) <= 2000),
    file_name     text not null check (length(file_name) between 1 and 120),
    digest        text not null check (digest ~ '^[0-9a-f]{64}$'),
    size          bigint not null check (size between 1 and 67108864),
    published_by  text not null references account (id),
    published_at  timestamptz not null,
    updated_at    timestamptz not null
);

create index resource_page_idx on resource (published_at desc, id desc);
