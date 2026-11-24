-- What the job runner remembers of each job, for the system page.

-- Global: one row per job name, the last run the runner finished (jobs/runner.ts). A failure keeps
-- its refusal code and nothing else, since a failure's detail can carry a statement's values. The
-- last failure stays after later runs succeed; `failed` says whether the last run was one.
create table job_run (
    name         text primary key,
    ran_at       timestamptz not null,
    duration_ms  integer not null check (duration_ms >= 0),
    failed       boolean not null,
    failed_at    timestamptz,
    failure      text check (failure ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    check ((failed_at is null) = (failure is null)),
    check (not failed or failed_at = ran_at)
);
