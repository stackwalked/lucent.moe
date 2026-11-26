-- A comment on a guide (product-scoped, by inheritance from its guide) or a comment on a member's
-- profile wall. Exactly one of the two targets is set. `profile_account_id` is global (not
-- product-scoped): a wall belongs to the account whose profile it is. Whether others may read or
-- write it is the owner's `profile.show_wall`; a wall goes with its owner's deletion.
alter table comment alter column guide_id drop not null;

alter table comment add column profile_account_id text references account (id);

alter table comment add constraint comment_one_target
    check ((guide_id is null) <> (profile_account_id is null));

create index comment_profile_page on comment (profile_account_id, created_at desc, id desc)
    where removed_at is null and profile_account_id is not null;
