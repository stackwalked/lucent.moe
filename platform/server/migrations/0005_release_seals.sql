-- Releases keyed per seal. Going back to an old release is its code signed again under a higher
-- number, so one release (its id, container and manifest) can have several seals; the seal and
-- its number move to `release_seal`, keyed by product, channel and number, and the highest number
-- signed is a query. `ops publish-release` and `publish-loader` write both tables; promotion
-- points at a seal.
--
-- 0004's comment on `release` is stale since this migration: ops publishes releases, the seal
-- lives here, and the container's and seal's formats are in contracts/ (container/v1,
-- release-seal/v1). 0004 stays as applied.

-- One signed seal. Numbers are u64 on the wire; ops refuses one above bigint's range.
create table release_seal (
    product_id  text not null,
    channel     text not null,
    number      bigint not null check (number > 0),
    release_id  bytea not null references release (id),
    seal        bytea not null check (length(seal) between 1 and 1048576),
    created_at  timestamptz not null default now(),
    primary key (product_id, channel, number)
);

create index release_seal_release_idx on release_seal (release_id);

-- Rows written before seals were verified get numbers in the order they were written.
insert into release_seal (product_id, channel, number, release_id, seal, created_at)
select product_id, channel,
       row_number() over (partition by product_id, channel order by created_at, id),
       id, seal, created_at
from release;

alter table release drop column seal;

-- Promotion names a seal, so it names the number a client will compare.
alter table current_release add column number bigint;
update current_release c set number = s.number
from release_seal s
where s.product_id = c.product_id and s.channel = c.channel and s.release_id = c.release_id;
alter table current_release
    alter column number set not null,
    drop column release_id,
    add foreign key (product_id, channel, number)
        references release_seal (product_id, channel, number);

-- A start hands out one seal; a replayed start hands out the same one.
alter table session_start add column release_number bigint;
update session_start st set release_number = (
    select max(s.number) from release_seal s
    where s.product_id = st.product_id and s.channel = st.channel
      and s.release_id = st.release_id
);
alter table session_start
    alter column release_number set not null,
    add foreign key (product_id, channel, release_number)
        references release_seal (product_id, channel, number);
