import { can } from "@lucent/policy/policy";
import { getRouteApi, Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Columns } from "../../ui/Columns/Columns.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { type Pair, Pairs } from "../../ui/Pairs/Pairs.tsx";
import { RoleLabel } from "../../ui/RoleLabel/RoleLabel.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import selectStyles from "../../ui/Select/Select.module.css";
import { Switch } from "../../ui/Switch/Switch.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { memberOf, subjectOf } from "../../viewer.ts";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { CLOUD_COPY } from "../cloud/copy.ts";
import { ListingRow } from "../cloud/ListingRow.tsx";
import { postingNote } from "../comments/posting.ts";
import { ReportButton } from "../comments/ReportButton.tsx";
import { blockAccount, saveShows, saveVisibility } from "../privacy/server.ts";
import { productName } from "../products/view.ts";
import { AVATAR_ACCEPT, uploadAvatar } from "./avatar.ts";
import { BANNER_ACCEPT, uploadBanner } from "./banner.ts";
import { PROFILE_COPY as C } from "./copy.ts";
import { ImageControl } from "./ImageControl.tsx";
import styles from "./ProfilePage.module.css";
import { removeAvatar, removeBanner, saveBio } from "./server.ts";
import { PROFILE_TITLE } from "./title.ts";
import { Wall } from "./Wall.tsx";

const route = getRouteApi("/_member/members/$username");

type ShowKey = "invitedBy" | "invited" | "products" | "lastSeen" | "discord" | "wall";

// A member's page as others see it. The main column opens with the banner and who this is, then
// "about" and the wall; the aside is "member", "products" and "invited", each only while the
// owner shows it. The banner block has no hairline, so the aside's first caption is the page's
// first hairline, 80px under the bar, and the main column's first hairline is "about"'s.
//
// On the owner's own page `?edit=true` makes each part its own control where it is shown, and a
// part the owner hides stays on the page, dimmed, so it can be turned back on. Outside edit mode
// the owner's page is exactly what another member reads, plus "edit".
export function ProfilePage() {
    const { profile: outcome, wall, shared, shows } = route.useLoaderData();
    const { edit } = route.useSearch();
    const router = useRouter();
    const { session } = useRouteContext({ from: "__root__" });
    const viewer = memberOf(session);
    const staff = viewer !== null && can(subjectOf(viewer), "accounts:read");
    const [refused, setRefused] = useState<Refused | null>(null);
    const [showsRefused, setShowsRefused] = useState<Refused | null>(null);
    const [bioRefused, setBioRefused] = useState<Refused | null>(null);
    const savedBio = outcome.ok ? outcome.value.bio : "";
    const [bio, setBio] = useState(savedBio);
    const [saving, setSaving] = useState(false);
    const [asked, setAsked] = useState(false);
    const top = useRef<HTMLDivElement>(null);
    const editLink = useRef<HTMLAnchorElement>(null);
    const wasEditing = useRef<boolean | null>(null);
    const editing = outcome.ok && outcome.value.isSelf && edit === "true";
    // What the server holds after a save is what the fields show again (it may have trimmed).
    useEffect(() => setBio(savedBio), [savedBio]);
    // Focus follows the mode: into the first control on entering, back onto "edit" on leaving.
    useEffect(() => {
        if (wasEditing.current !== null && wasEditing.current !== editing) {
            if (editing) top.current?.querySelector<HTMLElement>("button")?.focus();
            else editLink.current?.focus();
        }
        wasEditing.current = editing;
    }, [editing]);
    if (!outcome.ok) {
        return (
            <Page title={PROFILE_TITLE} width="narrow">
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const profile = outcome.value;
    const dirty = editing && bio !== profile.bio;
    const answered = async () => {
        await router.invalidate();
    };
    const save = async () => {
        setSaving(true);
        if (bio !== profile.bio) {
            const reply = await saveBio({ data: { bio } });
            setBioRefused(reply.ok ? null : reply.refused);
        }
        setAsked(false);
        await router.invalidate();
        setSaving(false);
    };
    // Unsaved text asks once: the first "done" turns into "discard".
    const leave = async () => {
        if (dirty && !asked) return setAsked(true);
        setAsked(false);
        setBio(profile.bio);
        setBioRefused(null);
        await router.navigate({
            to: "/members/$username",
            params: { username: profile.username },
            search: {},
        });
    };
    const shown = (key: ShowKey) =>
        !profile.isSelf || shows === null || !shows.ok || shows.value[key];
    // A block outside edit mode is what another member would read; in edit mode a hidden one
    // stays, dimmed, with its switch.
    const visible = (key: ShowKey, filled: boolean) => editing || (shown(key) && filled);
    const dim = (key: ShowKey) => (editing && !shown(key) ? styles.off : undefined);
    const showSwitch = (key: ShowKey, label: string) =>
        editing ? (
            <Switch
                key={`${key}-${String(shown(key))}`}
                name={key}
                label={label}
                hideLabel
                defaultChecked={shown(key)}
                onChange={async (on) => {
                    const reply = await saveShows({ data: { key, shown: on } });
                    setShowsRefused(reply.ok ? null : reply.refused);
                    if (reply.ok) await router.invalidate();
                }}
            />
        ) : undefined;
    const row = (
        key: ShowKey,
        label: string,
        value: Pair["value"] | null,
        tone?: Pair["tone"],
    ): Pair[] => {
        if (!visible(key, value !== null)) return [];
        if (!editing) return [{ label, value, ...(tone === undefined ? {} : { tone }) }];
        const off = !shown(key);
        const toned = off ? "dim" : tone;
        return [
            {
                label,
                value: (
                    <span className={styles.rowEnd}>
                        {value ?? C.none}
                        {showSwitch(key, label)}
                    </span>
                ),
                ...(toned === undefined ? {} : { tone: toned }),
            },
        ];
    };
    const member: Pair[] = [
        { label: C.number, value: C.memberNo(profile.memberNo) },
        { label: C.joined, value: <Time at={profile.joinedAt} format="month" /> },
        ...row(
            "invitedBy",
            C.invitedBy,
            profile.invitedBy === null ? null : (
                <Link to="/members/$username" params={{ username: profile.invitedBy }}>
                    {profile.invitedBy}
                </Link>
            ),
        ),
        ...row("discord", C.discord, profile.discord),
        ...row(
            "lastSeen",
            C.lastSeen,
            profile.lastSeen === null ? null : profile.lastSeen === "now" ? (
                C.now
            ) : (
                <Time at={profile.lastSeen} format="date" />
            ),
            profile.lastSeen === "now" ? "ok" : undefined,
        ),
        ...(editing
            ? [
                  {
                      label: C.visibility,
                      value: (
                          <select
                              className={selectStyles.control}
                              aria-label={C.visibility}
                              value={profile.visibility}
                              onChange={async (event) => {
                                  const reply = await saveVisibility({
                                      data: {
                                          visibility:
                                              event.currentTarget.value === "private"
                                                  ? "private"
                                                  : "members",
                                      },
                                  });
                                  setShowsRefused(reply.ok ? null : reply.refused);
                                  if (reply.ok) await router.invalidate();
                              }}
                          >
                              <option value="members">{C.members}</option>
                              <option value="private">{C.private}</option>
                          </select>
                      ),
                  },
              ]
            : []),
    ];
    const products = profile.products ?? [];
    const invited = profile.invited ?? [];
    const bioNote = postingNote(bioRefused);
    return (
        <Page title={null} hideTitle>
            <Columns
                main={
                    <>
                        <div ref={top}>
                            <div className={styles.banner}>
                                {profile.banner === null ? null : (
                                    <img
                                        className={styles.bannerImage}
                                        src={`/avatars/${profile.banner}`}
                                        alt=""
                                    />
                                )}
                                {editing ? (
                                    <ImageControl
                                        accept={BANNER_ACCEPT}
                                        has={profile.banner !== null}
                                        verbs={C.bannerOf}
                                        upload={uploadBanner}
                                        clear={removeBanner}
                                        answered={answered}
                                    />
                                ) : null}{" "}
                            </div>
                            <div className={styles.identity}>
                                <span className={styles.picBox}>
                                    <span className={styles.pic}>
                                        <Avatar
                                            digest={profile.avatar?.large ?? null}
                                            size="large"
                                        />
                                    </span>
                                    {editing ? (
                                        <ImageControl
                                            accept={AVATAR_ACCEPT}
                                            has={profile.avatar !== null}
                                            verbs={C.pictureOf}
                                            upload={uploadAvatar}
                                            clear={removeAvatar}
                                            answered={answered}
                                            shape="round"
                                        />
                                    ) : null}{" "}
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
                                </div>
                                <div className={styles.acts}>
                                    {editing ? (
                                        <>
                                            <Button
                                                tone="pink"
                                                size="sm"
                                                pending={saving}
                                                disabled={!dirty}
                                                onClick={save}
                                            >
                                                {C.save}
                                            </Button>
                                            <Button size="sm" onClick={leave}>
                                                {dirty && asked ? C.discard : C.done}
                                            </Button>
                                        </>
                                    ) : profile.isSelf ? (
                                        <Link
                                            ref={editLink}
                                            to="/members/$username"
                                            params={{ username: profile.username }}
                                            search={{ edit: "true" }}
                                            className={styles.edit}
                                        >
                                            {C.edit}
                                        </Link>
                                    ) : null}
                                    {staff ? (
                                        <Link
                                            to="/admin/members/accounts"
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
                                                await router.navigate({ to: "/account" });
                                            }}
                                        >
                                            {C.block}
                                        </Button>
                                    )}
                                </div>
                            </div>
                            {!editing && profile.isSelf && profile.visibility === "private" ? (
                                <p className={styles.quiet}>{C.private}</p>
                            ) : null}
                            <RefusalNote refused={refused} />
                        </div>
                        {editing || profile.bio !== "" ? (
                            <Section caption={C.about}>
                                {editing ? (
                                    <>
                                        <textarea
                                            className={styles.aboutInput}
                                            aria-label={C.about}
                                            value={bio}
                                            maxLength={500}
                                            onChange={(event) => {
                                                setAsked(false);
                                                setBio(event.currentTarget.value);
                                            }}
                                        />
                                        <RefusalNote
                                            refused={bioRefused}
                                            {...(bioNote === undefined ? {} : { extra: bioNote })}
                                        />
                                    </>
                                ) : (
                                    <p className={styles.about}>{profile.bio}</p>
                                )}
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
                        {wall !== null && visible("wall", true) ? (
                            <div className={dim("wall")}>
                                <Wall
                                    key={profile.username}
                                    username={profile.username}
                                    first={wall}
                                    actions={showSwitch("wall", C.wall)}
                                />
                            </div>
                        ) : null}
                    </>
                }
                aside={
                    <>
                        <Section caption={C.member}>
                            <Pairs items={member} align="end" />
                            {editing ? <RefusalNote refused={showsRefused} /> : null}
                        </Section>
                        {visible("products", products.length > 0) ? (
                            <div className={dim("products")}>
                                <Section
                                    caption={C.products}
                                    actions={showSwitch("products", C.products)}
                                >
                                    <ul className={styles.names}>
                                        {products.map((name) => (
                                            <li key={name}>{productName(name)}</li>
                                        ))}
                                    </ul>
                                </Section>
                            </div>
                        ) : null}
                        {visible("invited", invited.length > 0) ? (
                            <div className={dim("invited")}>
                                <Section
                                    caption={C.invited}
                                    actions={showSwitch("invited", C.invited)}
                                >
                                    <ul className={styles.names}>
                                        {invited.map((name) => (
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
                            </div>
                        ) : null}
                    </>
                }
            />
        </Page>
    );
}
