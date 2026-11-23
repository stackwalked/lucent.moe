-- Global: one staff queue for every product. A report names member-written content (a comment,
-- a shout, a guide or a profile bio) by kind and id; the content's own product, if any, comes from the content,
-- never from the report. target_id has no foreign key because it points at one of four tables;
-- the writers check the target exists and is visible to the reporter.
--
-- A member reports a thing once (the unique key), and a thing is removed once: resolving a report
-- with removal closes every open report on the same target. Nothing is deleted.
create table report (
    id uuid primary key default gen_random_uuid(),
    reporter_id text not null references account (id),
    target_kind text not null check (target_kind in ('comment', 'shout', 'guide', 'profile')),
    target_id uuid not null,
    reason text not null check (reason in ('spam', 'abuse', 'other')),
    note text not null default '' check (length(note) <= 500),
    created_at timestamptz not null default now(),
    state text not null default 'open' check (state in ('open', 'removed', 'dismissed')),
    resolved_by text references account (id),
    resolved_at timestamptz,
    unique (reporter_id, target_kind, target_id),
    check ((state = 'open') = (resolved_at is null)),
    check ((state = 'open') = (resolved_by is null))
);

create index report_queue on report (created_at, id) where state = 'open';
create index report_target on report (target_kind, target_id) where state = 'open';
