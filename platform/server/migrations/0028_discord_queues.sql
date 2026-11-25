-- Staff queues on Discord: open tickets and open review items posted to a staff channel as they
-- arrive and edited in place as their state changes. They are feed rules of two more kinds, which
-- the rule editor accepts only on a channel marked staff (discord/rules.ts).
alter table connector_discord_rule drop constraint connector_discord_rule_feed_check;
alter table connector_discord_rule
    add constraint connector_discord_rule_feed_check
    check (feed in ('status', 'resources', 'releases', 'tickets', 'review'));
