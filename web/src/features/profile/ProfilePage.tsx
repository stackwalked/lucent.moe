import { can } from "@lucent/policy/policy";
import { getRouteApi, Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { RoleLabel } from "../../ui/RoleLabel/RoleLabel.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf, subjectOf } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { CLOUD_COPY } from "../cloud/copy.ts";
import { ListingRow } from "../cloud/ListingRow.tsx";
import { ReportButton } from "../comments/ReportButton.tsx";
import { blockAccount } from "../privacy/server.ts";
import { productName } from "../products/view.ts";
import { PROFILE_COPY as C } from "./copy.ts";
import styles from "./ProfilePage.module.css";
import { PROFILE_TITLE } from "./title.ts";
import { Wall } from "./Wall.tsx";

const route = getRouteApi("/_member/members/$username");

// A member's page as others see it. The main column opens with the banner and who this is, then
// "about" and the wall; the aside is "member", "products" and "invited", each only while the
// owner shows it. The banner block has no hairline, so the aside's first caption is the page's
// first hairline, 80px under the bar, and the main column's first hairline is "about"'s.
export function ProfilePage() {
    const { profile: outcome, wall, shared } = route.useLoaderData();
    const router = useRouter();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const staff = viewer !== null && can(subjectOf(viewer), "accounts:read");
    const [refused, setRefused] = useState<Refused | null>(null);
    if (!outcome.ok) {
        return (
            <Page title={PROFILE_TITLE} width="narrow">
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const profile = outcome.value;
    const aboutShown = profile.bio !== "";
    const member = [
        { label: C.number, value: C.memberNo(profile.memberNo) },
        { label: C.joined, value: <Time at={profile.joinedAt} format="month" /> },
        ...(profile.invitedBy === null
            ? []
            : [
                  {
                      label: C.invitedBy,
                      value: (
                          <Link to="/members/$username" params={{ username: profile.invitedBy }}>
                              {profile.invitedBy}
                          </Link>
                      ),
                  },
              ]),
        ...(profile.discord === null ? [] : [{ label: C.discord, value: profile.discord }]),
        ...(profile.lastSeen === null
            ? []
            : [
                  profile.lastSeen === "now"
                      ? { label: C.lastSeen, value: C.now, tone: "ok" as const }
                      : {
                            label: C.lastSeen,
                            value: <Time at={profile.lastSeen} format="date" />,
                        },
              ]),
    ];
    return (
        <Page title={null} hideTitle>
            <Columns
                main={
                    <>
                        <div>
                            <div className={styles.banner}>
                                {profile.banner === null ? null : (
                                    <img
                                        className={styles.bannerImage}
                                        src={`/avatars/${profile.banner}`}
                                        alt=""
                                    />
                                )}
                            </div>
                            <div className={styles.identity}>
                                <span className={styles.pic}>
                                    <Avatar digest={profile.avatar?.large ?? null} size="large" />
                                </span>
                                <div className={styles.who}>
                                    <h1 className={styles.name}>
                                        {profile.username}
                                        {profile.role === null ? null : (
                                            <span className={styles.role}>
                                                <RoleLabel
                                                    name={profile.role.name}
                                                    color={profile.role.color}
                                                />
                                            </span>
                                        )}
                                    </h1>
                                    {profile.tagline === "" ? null : (
                                        <p className={styles.tagline}>{profile.tagline}</p>
                                    )}
                                </div>
                                <div className={styles.acts}>
                                    {profile.isSelf ? (
                                        <Link to="/account/profile" className={styles.edit}>
                                            {C.edit}
                                        </Link>
                                    ) : null}
                                    {staff ? (
                                        <Link
                                            to="/admin/accounts"
                                            search={{ q: profile.username }}
                                            className={styles.act}
                                        >
                                            {C.admin}
                                        </Link>
                                    ) : null}
                                    {profile.isSelf ||
                                    profile.id === null ||
                                    (profile.bio === "" && profile.avatar === null) ? null : (
                                        <ReportButton kind="profile" targetId={profile.id} />
                                    )}
                                    {profile.isSelf ? null : (
                                        <Button
                                            size="sm"
                                            tone="ghost"
                                            onClick={async () => {
                                                const reply = await blockAccount({
                                                    data: {
                                                        username: profile.username,
                                                        blocked: true,
                                                    },
                                                });
                                                if (!reply.ok) return setRefused(reply.refused);
                                                await router.navigate({ to: "/account/privacy" });
                                            }}
                                        >
                                            {C.block}
                                        </Button>
                                    )}
                                </div>
                            </div>
                            <RefusalNote refused={refused} />
                        </div>
                        {aboutShown ? (
                            <Section caption={C.about}>
                                <p className={styles.about}>{profile.bio}</p>
                            </Section>
                        ) : null}
                        {shared === null || !shared.ok || shared.value.items.length === 0 ? null : (
                            <Section caption={CLOUD_COPY.shared}>
                                <ul className={styles.names}>
                                    {shared.value.items.map((listing) => (
                                        <ListingRow
                                            key={listing.id}
                                            listing={listing}
                                            variant="brief"
                                            after={productName(listing.productId)}
                                        />
                                    ))}
                                </ul>
                            </Section>
                        )}
                        {profile.wall && wall !== null ? (
                            <Wall key={profile.username} username={profile.username} first={wall} />
                        ) : null}
                    </>
                }
                aside={
                    <>
                        <Section caption={C.member}>
                            <Pairs items={member} align="end" />
                        </Section>
                        {profile.products === null || profile.products.length === 0 ? null : (
                            <Section caption={C.products}>
                                <ul className={styles.names}>
                                    {profile.products.map((name) => (
                                        <li key={name}>{productName(name)}</li>
                                    ))}
                                </ul>
                            </Section>
                        )}
                        {profile.invited === null || profile.invited.length === 0 ? null : (
                            <Section caption={C.invited}>
                                <ul className={styles.names}>
                                    {profile.invited.map((name) => (
                                        <li key={name}>
                                            <Link
                                                to="/members/$username"
                                                params={{ username: name }}
                                            >
                                                {name}
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            </Section>
                        )}
                    </>
                }
            />
        </Page>
    );
}
