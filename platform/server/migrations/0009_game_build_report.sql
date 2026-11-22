-- The game module builds the latest start reported, per product, whether the start went ahead or
-- was refused as GAME_BUILD_UNSUPPORTED. A refused start stores nothing else, so without this the
-- product page would know only builds some current set already covered, and couldn't say "not yet
-- supported" after a game update. Modules as `session_start.modules` holds them.
create table game_build_report (
    product_id   text primary key,
    modules      jsonb not null,
    reported_at  timestamptz not null
);
