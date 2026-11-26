import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Avatar } from "../../ui/Avatar/Avatar.tsx";
import { Button } from "../../ui/Button/Button.tsx";
import { Field } from "../../ui/Field/Field.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Pairs } from "../../ui/Pairs/Pairs.tsx";
import { Section } from "../../ui/Section/Section.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { Time } from "../../ui/Time/Time.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { ReportButton } from "../comments/ReportButton.tsx";
import { TextArea } from "../comments/TextArea.tsx";
import { blockAccount } from "../privacy/server.ts";
import { AVATAR_ACCEPT, uploadAvatar } from "./avatar.ts";
import { BANNER_ACCEPT, uploadBanner } from "./banner.ts";
import { PROFILE_COPY } from "./copy.ts";
import { removeAvatar, removeBanner, saveBio, saveTagline } from "./server.ts";
import { PROFILE_TITLE } from "./title.ts";

const route = getRouteApi("/_member/members/$username");

export function ProfilePage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [taglineRefused, setTaglineRefused] = useState<Refused | null>(null);
    const [pictureRefused, setPictureRefused] = useState<Refused | null>(null);
    const [bannerRefused, setBannerRefused] = useState<Refused | null>(null);
    const saveTag = async (form: FormData) => {
        const reply = await saveTagline({ data: { tagline: String(form.get("tagline") ?? "") } });
        setTaglineRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const sendBanner = async (form: FormData) => {
        const file = form.get("banner");
        if (!(file instanceof File) || file.size === 0) return;
        const reply = await uploadBanner(file);
        setBannerRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const takeDownBanner = async () => {
        const reply = await removeBanner();
        setBannerRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const save = async (form: FormData) => {
        const reply = await saveBio({ data: { bio: String(form.get("bio") ?? "") } });
        setRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const sendPicture = async (form: FormData) => {
        const file = form.get("picture");
        if (!(file instanceof File) || file.size === 0) return;
        const reply = await uploadAvatar(file);
        setPictureRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    const takeDownPicture = async () => {
        const reply = await removeAvatar();
        setPictureRefused(reply.ok ? null : reply.refused);
        if (reply.ok) await router.invalidate();
    };
    if (!outcome.ok) {
        return (
            <Page title={PROFILE_TITLE} width="narrow">
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const profile = outcome.value;
    const note = postingNote(refused);
    const pictureNote = postingNote(pictureRefused);
    return (
        <Page title={profile.username} width="narrow">
            <Stack gap={6}>
                <Avatar digest={profile.avatar?.large ?? null} size="large" />
                <Pairs
                    items={[
                        {
                            label: PROFILE_COPY.joined,
                            value: <Time at={profile.joinedAt} />,
                        },
                    ]}
                />
                <p>{profile.bio === "" ? PROFILE_COPY.noBio : profile.bio}</p>
                {profile.isSelf ||
                profile.id === null ||
                (profile.bio === "" && profile.avatar === null) ? null : (
                    <div>
                        <ReportButton kind="profile" targetId={profile.id} />
                    </div>
                )}
                {profile.isSelf ? null : (
                    <div>
                        <Button
                            tone="danger"
                            onClick={async () => {
                                const reply = await blockAccount({
                                    data: { username: profile.username, blocked: true },
                                });
                                if (!reply.ok) return setRefused(reply.refused);
                                await router.navigate({ to: "/account/privacy" });
                            }}
                        >
                            {PROFILE_COPY.block}
                        </Button>
                    </div>
                )}
                {profile.isSelf ? (
                    <Section caption={PROFILE_COPY.edit}>
                        <Stack gap={6}>
                            <form action={sendPicture} key={profile.avatar?.large ?? "none"}>
                                <Stack gap={3}>
                                    <RefusalNote
                                        refused={pictureRefused}
                                        {...(pictureNote === undefined
                                            ? {}
                                            : { extra: pictureNote })}
                                    />
                                    <Field
                                        label={PROFILE_COPY.picture}
                                        hint={PROFILE_COPY.pictureHint}
                                    >
                                        {(control) => (
                                            <input
                                                {...control}
                                                type="file"
                                                name="picture"
                                                accept={AVATAR_ACCEPT}
                                                required
                                            />
                                        )}
                                    </Field>
                                    <div>
                                        <Button type="submit">{PROFILE_COPY.upload}</Button>{" "}
                                        {profile.avatar === null ? null : (
                                            <Button tone="danger" onClick={takeDownPicture}>
                                                {PROFILE_COPY.removePicture}
                                            </Button>
                                        )}
                                    </div>
                                </Stack>
                            </form>
                            <form action={sendBanner} key={profile.banner ?? "none"}>
                                <Stack gap={3}>
                                    <RefusalNote refused={bannerRefused} />
                                    {profile.banner === null ? null : (
                                        <img
                                            src={`/avatars/${profile.banner}`}
                                            alt=""
                                            width={300}
                                            height={80}
                                        />
                                    )}
                                    <Field
                                        label={PROFILE_COPY.banner}
                                        hint={PROFILE_COPY.pictureHint}
                                    >
                                        {(control) => (
                                            <input
                                                {...control}
                                                type="file"
                                                name="banner"
                                                accept={BANNER_ACCEPT}
                                                required
                                            />
                                        )}
                                    </Field>
                                    <div>
                                        <Button type="submit">{PROFILE_COPY.upload}</Button>{" "}
                                        {profile.banner === null ? null : (
                                            <Button tone="danger" onClick={takeDownBanner}>
                                                {PROFILE_COPY.removeBanner}
                                            </Button>
                                        )}
                                    </div>
                                </Stack>
                            </form>
                            <form action={saveTag} key={profile.tagline}>
                                <Stack gap={3}>
                                    <RefusalNote refused={taglineRefused} />
                                    <TextField
                                        name="tagline"
                                        label={PROFILE_COPY.tagline}
                                        maxLength={80}
                                        defaultValue={profile.tagline}
                                    />
                                    <div>
                                        <Button type="submit">{PROFILE_COPY.save}</Button>
                                    </div>
                                </Stack>
                            </form>
                            <form action={save} key={profile.bio}>
                                <Stack gap={3}>
                                    <RefusalNote
                                        refused={refused}
                                        {...(note === undefined ? {} : { extra: note })}
                                    />
                                    <TextArea
                                        name="bio"
                                        label={PROFILE_COPY.bio}
                                        maxLength={500}
                                        defaultValue={profile.bio}
                                    />
                                    <div>
                                        <Button type="submit">{PROFILE_COPY.save}</Button>
                                    </div>
                                </Stack>
                            </form>
                        </Stack>
                    </Section>
                ) : null}
            </Stack>
        </Page>
    );
}
