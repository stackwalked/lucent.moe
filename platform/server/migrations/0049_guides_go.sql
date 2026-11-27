-- Guides are gone. What is written about them goes first: reports on a guide or on a comment
-- under one (the queue joins the content, so they would wait in no queue), then the comments
-- themselves; a comment is from here on always a comment on a profile wall, which stays as it is.
-- The guide table takes its indexes and its search column with it.
delete from report
    where target_kind = 'guide'
       or (target_kind = 'comment'
           and target_id in (select id from comment where guide_id is not null));

delete from comment where guide_id is not null;

alter table comment drop constraint comment_one_target;
alter table comment drop column guide_id;
alter table comment alter column profile_account_id set not null;

drop index comment_profile_page;
create index comment_profile_page on comment (profile_account_id, created_at desc, id desc)
    where removed_at is null;

drop table guide;

alter table report drop constraint report_target_kind_check;
alter table report add constraint report_target_kind_check
    check (target_kind in ('comment', 'shout', 'profile', 'listing'));
