-- History is a window: a full item drops its oldest version to make room for the next. Versions
-- stay immutable, and while the item exists neither its current version nor one a share link
-- grants may go; removing the item still takes all of them.
create or replace function protect_cloud_version() returns trigger language plpgsql as $$
begin
    if tg_op = 'UPDATE' or (
        exists (
            select 1 from cloud_item where (account_id, product_id, item_id) =
                (old.account_id, old.product_id, old.item_id)
        ) and (
            not exists (
                select 1 from cloud_version where (account_id, product_id, item_id) =
                    (old.account_id, old.product_id, old.item_id) and revision > old.revision
            ) or exists (
                select 1 from cloud_share where (account_id, product_id, item_id, revision) =
                    (old.account_id, old.product_id, old.item_id, old.revision)
            )
        )
    ) then
        raise exception 'cloud versions are immutable while the item exists'
            using errcode = 'check_violation', constraint = 'cloud_version_immutable';
    end if;
    return old;
end;
$$;
