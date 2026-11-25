-- A staff reply on a member's help ticket is a notice of its own kind. Global per account: the
-- member's inbox and mail choices for it apply to every ticket. It has no Discord DM yet, so the
-- DM table keeps its two kinds.
alter table notification_preference drop constraint notification_preference_kind_check;
alter table notification_preference
    add constraint notification_preference_kind_check
    check (kind in ('product_status', 'security', 'ticket_reply'));

-- Global per account: a ticket_reply entry names its ticket and nothing of what was said, so
-- the inbox can link to it and never carries the reply text or the subject. The ticket's
-- deletion takes the entries with it.
alter table inbox_entry add column ticket_id uuid references ticket (id) on delete cascade;
alter table inbox_entry drop constraint inbox_entry_kind_check;
alter table inbox_entry drop constraint inbox_entry_check;
alter table inbox_entry
    add constraint inbox_entry_kind_check
    check (kind in ('security', 'product_status', 'ticket_reply'));
alter table inbox_entry
    add constraint inbox_entry_subject_check
    check ((kind = 'product_status') = (product_id is not null)
       and (kind = 'ticket_reply') = (ticket_id is not null));
