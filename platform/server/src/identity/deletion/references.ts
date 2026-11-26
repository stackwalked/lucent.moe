// Every column that holds an account id, and what completing a deletion does with it: `goes` is
// named in deletion/strip.ts, `stays` says why it is left. tests/deletion-references.test.ts walks
// the schema (declared foreign keys to `account`, and text columns named like an account id that
// declare none) and fails on a column missing here or listed here and gone, so a new table can't
// forget the question.
export type Fate = { readonly fate: "goes" | "stays"; readonly why: string };

const goes = (why: string): Fate => ({ fate: "goes", why });
const stays = (why: string): Fate => ({ fate: "stays", why });

const STAFF = "written by staff, about their own act";
const NO_ID = "json holding no account id";

export const ACCOUNT_REFERENCES: Readonly<Record<string, Fate>> = {
    // Authority.
    "username_claim.account_id": goes(
        "every claimed name becomes a digest in retired_username, with no account beside it",
    ),
    "account_role.account_id": stays(
        "completion is refused while a role is held; an expired grant is staff's history",
    ),
    "entitlement.account_id": stays("revoked at completion; the licence history stays"),
    "audit.actor_id": stays("the audit trail; usernames recorded in targets are removed"),
    "receipt.principal": goes("the member's own replay caches can hold what they sent"),

    // Sign-in.
    "passkey.account_id": goes("a credential"),
    "password_credential.account_id": goes("a credential"),
    "totp_credential.account_id": goes("a credential"),
    "browser_session.account_id": goes("ended by revokeAccess"),
    "auth_flow.account_id": goes("ended by revokeAccess"),
    "setup_token.account_id": goes("ended by revokeAccess"),
    "setup_token.issued_by": stays(STAFF),
    "password_reset.account_id": goes("ended by revokeAccess, with its queued mail"),
    "native_auth_request.account_id": goes("a loader sign-in in flight"),
    "native_token_family.account_id": goes("a loader's tokens, revoked first by revokeAccess"),
    "sign_in_observation.account_id": goes("where the member signed in from"),
    "sign_in_country.account_id": goes("where the member signed in from"),

    // Devices and the native path: device records stay, so a suspended person's PCs stay theirs.
    "device.account_id": stays("a device record; the name the member gave it is cleared"),
    "device_change_window.account_id": stays("a device record: an id and a time"),
    "device_enrollment.account_id": stays("a device record; a pending one is expired"),
    "product_slot.account_id": stays("an id and a counter; its hold is cleared by revokeAccess"),
    "session_start.account_id": stays(
        "consumed and its key wiped by revokeAccess; runtime sessions point at it",
    ),
    "runtime_session.account_id": stays(
        "ended and its keys wiped by revokeAccess; what a device ran, which risk signals name",
    ),

    // Cloud.
    "cloud_scope.account_id": goes("with every item"),
    "cloud_item.account_id": goes("the member's configs, inventories and scripts"),
    "cloud_version.account_id": goes("with its item"),
    "cloud_share.account_id": goes("share links to what goes"),

    // Notices.
    "notification_preference.account_id": goes("the member's choices"),
    "product_subscription.account_id": goes("what the member followed"),
    "inbox_entry.account_id": goes("the member's notices"),
    "connector_discord_dm.account_id": goes("a notice waiting to be sent"),

    // Discord.
    "connector_discord_link.account_id": goes(
        "the unlink audit row it leaves makes the connector drop the roles",
    ),
    "connector_discord_link_code.account_id": goes("a link code"),

    // Community.
    "profile.account_id": goes("the bio and avatar"),
    "profile.removed_by": stays(STAFF),
    "guide.author_id": goes("with every comment under it"),
    "guide.removed_by": stays(STAFF),
    "comment.author_id": goes("what the member wrote"),
    "comment.profile_account_id": goes("the member's wall goes with them"),
    "comment.removed_by": stays(STAFF),
    "shout.author_id": goes("what the member wrote"),
    "shout.removed_by": stays(STAFF),
    "report.reporter_id": goes("reports the member made, with their notes"),
    "report.resolved_by": stays(STAFF),
    "account_block.blocker_id": goes("the member's blocks"),
    "account_block.blocked_id": goes("a block of someone who is gone hides nothing"),
    "community_restriction.account_id": stays("moderation history"),
    "community_restriction.set_by": stays(STAFF),
    "community_restriction.lifted_by": stays(STAFF),

    // Support.
    "ticket.account_id": stays(
        "staff replies stay; the owner's subject and messages go 30 days on (jobs/retention.ts)",
    ),
    "ticket_message.author_id": stays(
        "staff's messages stay; the member's own go 30 days after deletion (jobs/retention.ts)",
    ),
    "ticket_consent.account_id": stays("the record of what support was allowed to read, no text"),
    "resource.published_by": stays(STAFF),
    "resource_upload.uploaded_by": stays(STAFF),

    // Risk and facts.
    "risk_signal.account_id": stays("evidence, kept for its retention period as for any account"),
    "review_item.account_id": stays("staff's review and its outcome"),
    "review_item.decided_by": stays(STAFF),
    "fact_override.set_by": stays(STAFF),

    // Admission.
    "invite_allowance.account_id": stays("an id and a number"),
    "invite.inviter_id": stays("redeemed invites are the invite tree; open ones are revoked"),
    "invite.invitee_id": stays("the invite tree"),
    "application.account_id": goes("the application holds the address and what was written"),
    "application.decided_by": stays(STAFF),
    "application.known_by": stays(
        "not an id: a username as another applicant typed it, linked to nothing",
    ),
    // Json columns, where an id can sit under any key. Those that hold one are named for what they
    // hold; the rest are listed so a new json column has to be looked at too.
    "audit.target": stays(
        "names the account under accountId (and others under their own keys); usernames are removed",
    ),
    "receipt.result": stays(
        "staff's create and rename receipts naming the account go; other staff receipts hold ids only",
    ),
    "review_item.signals": stays("what fed staff's review, for staff only; kept with the review"),
    "connector_discord_rule.condition": stays(NO_ID),
    "device.public_key": stays(NO_ID),
    "device_enrollment.public_key": stays(NO_ID),
    "entitlement_product.features": stays(NO_ID),
    "game_build_report.modules": stays(NO_ID),
    "product_support.builds": stays(NO_ID),
    "role.channel_grants": stays(NO_ID),
    "runtime_session.asked_modules": stays(NO_ID),
    "session_start.modules": stays(NO_ID),
    "application.returning_account_id": stays(
        "names an earlier tombstone for staff; the application itself has its own retention",
    ),
};
