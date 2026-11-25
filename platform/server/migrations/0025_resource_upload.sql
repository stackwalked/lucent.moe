-- Global. The digests that came in through the resource upload route. ARTIFACT_DIR also holds
-- loader and module builds under their digests, and a resource is published by digest: without
-- this record staff could publish a build's digest and hand it to members who hold no
-- entitlement to it. A resource published before this table existed keeps working; its digest
-- is recorded here so it can be published again.
create table resource_upload (
    digest       text primary key check (digest ~ '^[0-9a-f]{64}$'),
    size         bigint not null check (size between 1 and 67108864),
    uploaded_by  text not null references account (id),
    uploaded_at  timestamptz not null
);

insert into resource_upload (digest, size, uploaded_by, uploaded_at)
select distinct on (digest) digest, size, published_by, published_at
from resource order by digest, published_at;
