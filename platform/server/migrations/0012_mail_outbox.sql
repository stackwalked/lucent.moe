-- Global delivery queue, per recipient; staff see terminal failures only through the audit feed.
create table mail_outbox (
    id uuid primary key default gen_random_uuid(),
    -- Audit readers correlate a row without learning its provider-facing replay key.
    staff_ref uuid not null unique default gen_random_uuid() check (staff_ref <> id),
    recipient text,
    subject text,
    body text,
    state text not null default 'pending' check (state in ('pending', 'sending', 'accepted', 'dead')),
    attempts integer not null default 0 check (attempts between 0 and 12),
    first_attempt_at timestamptz,
    binding text,
    due_at timestamptz default now(),
    finished_at timestamptz,
    check ((attempts = 0) = (first_attempt_at is null)),
    check ((attempts = 0) = (binding is null)),
    check (state <> 'sending' or attempts > 0),
    check ((state in ('pending', 'sending')) = (due_at is not null)),
    check ((state in ('accepted', 'dead')) = (finished_at is not null)),
    check ((state in ('pending', 'sending')) = (recipient is not null)),
    check ((state in ('pending', 'sending')) = (subject is not null)),
    check ((state in ('pending', 'sending')) = (body is not null))
);

create index mail_outbox_due on mail_outbox (due_at, id) where due_at is not null;
