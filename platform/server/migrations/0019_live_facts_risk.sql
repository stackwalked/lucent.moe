-- Slice 3's server side: live data revisions, kill switches as staff set them, the builds starts
-- report and when a promotion first covered them, risk signals and the review queue they feed.

-- What a running session has been given. `data_revision` is the number its lease and data
-- responses carry: it rises whenever a promotion or a kill switch changes what the session would
-- be sent. `asked_modules` are the builds the data route was asked for beyond those the start
-- reported (late-loaded modules), in session_start.modules' form, so a promotion of one of
-- theirs reaches the session too.
alter table runtime_session
    add column data_revision bigint not null default 0 check (data_revision >= 0),
    add column asked_modules jsonb not null default '[]';

-- Product-scoped, through its release: the kill switches staff set on one module release. A row
-- forces one feature (its keyed id from the release manifest) or one capability off for every
-- session on that release; clearing the switch deletes the row, and the audit keeps the history.
-- Keys are u64, so numeric.
create table fact_override (
    release_id  bytea not null references release (id),
    kind        text not null check (kind in ('feature', 'capability')),
    key         numeric(20, 0) not null check (key > 0 and key < 18446744073709551616),
    set_by      text not null references account (id),
    set_at      timestamptz not null,
    primary key (release_id, kind, key)
);

-- Product-scoped, through its release: the revision of the release's override document, one
-- higher with every change to its switches. The document's signed form will carry it, so a module
-- can tell a withheld newer document from the one it holds.
create table fact_override_revision (
    release_id  bytea primary key references release (id),
    revision    bigint not null check (revision > 0),
    changed_at  timestamptz not null
);

-- Product-scoped: each game module build any start reported for the product, when that first
-- happened, and when a promotion of a set listing it first made it current on one of the
-- product's releases. Update-day latency is the gap between the two.
create table module_build_seen (
    product_id         text not null,
    name_hash          numeric(20, 0) not null
                       check (name_hash >= 0 and name_hash < 18446744073709551616),
    time_date_stamp    bigint not null check (time_date_stamp between 0 and 4294967295),
    size_of_image      bigint not null check (size_of_image between 0 and 4294967295),
    first_reported_at  timestamptz not null,
    first_covered_at   timestamptz,
    primary key (product_id, name_hash, time_date_stamp, size_of_image)
);

create index module_build_seen_recent_idx on module_build_seen (first_reported_at desc);

-- Global per account, each row tagged with the release it was observed on (null for what the
-- server observes outside a session). Append-only: a signal is evidence, never edited. Kinds are
-- what the server can tell today; the weights live in risk/score.rules.ts.
create table risk_signal (
    id           bigint generated always as identity primary key,
    account_id   text not null references account (id) on delete cascade,
    release_id   bytea references release (id),
    session_id   bytea references runtime_session (id) on delete set null,
    kind         text not null check (kind in ('loader_silent', 'software_device_key')),
    observed_at  timestamptz not null
);

create index risk_signal_account_idx on risk_signal (account_id, observed_at);
create index risk_signal_observed_idx on risk_signal (observed_at);

-- Global: the time the scoring job last read risk_signal up to. One row.
create table risk_scoring_cursor (
    id              boolean primary key default true check (id),
    scored_through  timestamptz not null default '-infinity'
);

insert into risk_scoring_cursor default values;

-- Global per account: one review item a person acts on. The scoring job opens one when an
-- account's signals since its last decided item reach the threshold, and only ever raises an open
-- item's scores; staff close it with an outcome. `signals` names what contributed, for staff
-- only.
create table review_item (
    id              bigint generated always as identity primary key,
    account_id      text not null references account (id) on delete cascade,
    risk_score      integer not null check (risk_score between 0 and 100),
    urgency_score   integer not null check (urgency_score between 0 and 100),
    signals         jsonb not null,
    opened_at       timestamptz not null,
    scored_at       timestamptz not null,
    decided_at      timestamptz,
    decided_by      text references account (id),
    outcome         text check (outcome in ('no_action', 'actioned')),
    note            text check (length(note) <= 500),
    constraint review_item_decided check (
        (decided_at is null) = (outcome is null) and (decided_at is null) = (decided_by is null)
    )
);

create unique index review_item_open_idx on review_item (account_id) where decided_at is null;
create index review_item_queue_idx on review_item (decided_at desc nulls first, id desc);
