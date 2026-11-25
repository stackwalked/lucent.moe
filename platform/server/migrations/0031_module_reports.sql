-- The reports route's share of a session, as 0008 gave the data route its own keys and
-- sequences. Nothing on this route precedes the module's first batch, so its first frame and
-- the server's first ack are both sequence 1. `reports_accepted` counts the events stored for the
-- session, which caps them. Sessions opened before this have no reports keys and no route.
alter table runtime_session
    add column reports_key_to_server bytea check (length(reports_key_to_server) = 32),
    add column reports_key_to_module bytea check (length(reports_key_to_module) = 32),
    add column reports_in_sequence numeric(20, 0) not null default 0,
    add column reports_out_sequence numeric(20, 0) not null default 1,
    add column reports_accepted integer not null default 0 check (reports_accepted >= 0);

-- Product-scoped, through its release: one health event or crash summary a module reported, as
-- the reports layout carries it and nothing more. No account, session or device: nothing here
-- identifies a PC. `received_at` is the hour the batch arrived, not the moment: an exact time
-- would match the module_trap risk_signal written in the same transaction, which names the
-- account and session. The 30-day sweep and the crashes page's newest-first order work at that
-- grain (the page breaks ties by row id). `session_ms` is the module's monotonic time since its
-- session opened. Kept 30 days (jobs/retention.ts). Hashes and keys are u64, so numeric.
create table module_report (
    id              bigint generated always as identity primary key,
    product_id      text not null,
    release_id      bytea not null references release (id),
    received_at     timestamptz not null,
    session_ms      bigint not null check (session_ms between 0 and 4294967295),
    kind            text not null check (kind in ('health', 'crash')),
    event_id        integer check (event_id between 0 and 65535),
    subject         numeric(20, 0) check (subject >= 0 and subject < 18446744073709551616),
    value           bigint check (value between 0 and 4294967295),
    exception_code  bigint check (exception_code between 0 and 4294967295),
    module_hash     numeric(20, 0)
                    check (module_hash >= 0 and module_hash < 18446744073709551616),
    rva             bigint check (rva between 0 and 4294967295),
    frames          bigint[] check (cardinality(frames) <= 16),
    constraint module_report_fields check (
        case kind
            when 'health' then
                event_id is not null and subject is not null and value is not null
                and exception_code is null and module_hash is null and rva is null
                and frames is null
            else
                event_id is null and subject is null and value is null
                and exception_code is not null and module_hash is not null and rva is not null
                and frames is not null
        end
    )
);

create index module_report_received_idx on module_report (received_at);
-- The crashes page: a release's crashes grouped by where they happened.
create index module_report_crash_idx on module_report (release_id, module_hash, rva, received_at)
    where kind = 'crash';
-- Its product filter, which names no release.
create index module_report_crash_product_idx on module_report (product_id, received_at)
    where kind = 'crash';
