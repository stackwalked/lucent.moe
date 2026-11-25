-- The one way root changes hands.

-- Replaces 0001's: root moves only through `ops transfer-superadmin` (system/root-transfer.ts),
-- which names the two accounts in `lucent.root_transfer` inside its transaction, with the old root
-- first. Only those two rows may change, the old root only losing root and the new one only gaining
-- it; the setting is transaction-local, so committed or rolled back, the trigger is whole again.
create or replace function enforce_root_permanence() returns trigger language plpgsql as $$
declare
    transfer text := coalesce(current_setting('lucent.root_transfer', true), '');
begin
    if new.is_root is not distinct from old.is_root then
        return new;
    end if;
    if transfer <> '' and (
        (old.is_root and old.id = split_part(transfer, ' ', 1))
        or (new.is_root and old.id = split_part(transfer, ' ', 2))
    ) then
        return new;
    end if;
    raise exception 'root moves only through ops transfer-superadmin'
        using errcode = 'check_violation', constraint = 'account_root_permanent';
end;
$$;
