-- The data route's share of a session. Every route has its own keys and frame sequences, so a
-- lease renewal and a data request never stale each other; the lease route's stay in key_to_*
-- and frame_*_sequence. The reports route's keys are not stored until something serves it.
alter table runtime_session
    add column data_key_to_server bytea check (length(data_key_to_server) = 32),
    add column data_key_to_module bytea check (length(data_key_to_module) = 32),
    -- The first data frame, in the session reply, is server-to-module sequence 0.
    add column data_in_sequence numeric(20, 0) not null default 0,
    add column data_out_sequence numeric(20, 0) not null default 1;

-- The module builds a start reported, as [name hash, time-date stamp, size of image] triples
-- (the name hash a decimal string, being a u64): the session's first bundle is built for them.
alter table session_start
    add column modules jsonb not null default '[]';
