-- Prefix reads for the staff search box. LIKE 'x%' uses a btree only with the byte-order operator
-- class (the unique indexes are in the database's collation), so these sit beside them.
create index account_username_prefix on account (username text_pattern_ops)
    where username is not null and deleted_at is null;
create index account_email_prefix on account (email text_pattern_ops) where deleted_at is null;
create index device_jkt_prefix on device (jkt text_pattern_ops) where revoked_at is null;
create index ticket_subject_prefix on ticket (lower(subject) text_pattern_ops)
    where subject is not null;
