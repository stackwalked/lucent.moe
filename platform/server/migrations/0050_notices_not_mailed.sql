-- No notice is emailed any more, so the per-kind email choice goes. The outbox stays: the reset
-- link, the setup link and the deletion notice still use it.
alter table notification_preference drop column mail;
