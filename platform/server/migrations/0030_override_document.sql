-- Product-scoped, through the release: the data response version its module reads, as its
-- release manifest states it (version 4 says; version 3 manifests were built for 2). Every release
-- before this one reads 2, and a loader release's is never asked.
alter table release
    add column data_response smallint not null default 2 check (data_response in (2, 3));

-- Product-scoped, through the release: the override document at this revision, signed with the
-- override key in the transaction that took the revision. Null for revisions taken before
-- documents were signed, and on a server running without native config, which signs nothing.
alter table fact_override_revision
    add column document bytea check (length(document) between 1 and 1048576);
