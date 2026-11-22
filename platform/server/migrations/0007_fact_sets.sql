-- Fact sets as `ops publish-fact-set` stores them. A set is signed for one release (its manifest
-- digest) and lists the game module builds that shaped it, usually one, several for a set whose
-- facts span modules. It is stored as published, a bundle of one complete set (contracts/
-- fact-bundle/v1), and indexed by every build it lists: the start asks "which set is current for
-- this release and this build", and a revision is compared per release and build, so one build
-- can't be published at a revision it already has or lost to a newer one.

create table fact_set (
    id          bigint generated always as identity primary key,
    release_id  bytea not null references release (id),
    -- The bytes as published, signature included.
    bundle      bytea not null check (length(bundle) > 0),
    -- Every entry's key, u64 little-endian and sorted: what core coverage reads at a start
    -- without decoding the entries.
    fact_keys   bytea not null check (length(fact_keys) % 8 = 0),
    created_at  timestamptz not null default now()
);

-- Module builds as (name hash, TimeDateStamp, SizeOfImage); the name hash is a u64, so numeric.
create table fact_set_build (
    set_id           bigint not null references fact_set (id),
    release_id       bytea not null,
    name_hash        numeric(20, 0) not null
                     check (name_hash >= 0 and name_hash < 18446744073709551616),
    time_date_stamp  bigint not null check (time_date_stamp between 0 and 4294967295),
    size_of_image    bigint not null check (size_of_image between 0 and 4294967295),
    revision         bigint not null check (revision between 0 and 4294967295),
    primary key (release_id, name_hash, time_date_stamp, size_of_image, revision),
    unique (set_id, name_hash, time_date_stamp, size_of_image)
);

create index fact_set_build_set_idx on fact_set_build (set_id);

-- One current revision per release and module build; promotion replaces the row, as for
-- `current_release`, and is not written by ops yet. A build with no row has no supported set.
create table current_fact_set (
    release_id       bytea not null,
    name_hash        numeric(20, 0) not null,
    time_date_stamp  bigint not null,
    size_of_image    bigint not null,
    revision         bigint not null,
    promoted_at      timestamptz not null default now(),
    primary key (release_id, name_hash, time_date_stamp, size_of_image),
    foreign key (release_id, name_hash, time_date_stamp, size_of_image, revision)
        references fact_set_build (release_id, name_hash, time_date_stamp, size_of_image, revision)
);
