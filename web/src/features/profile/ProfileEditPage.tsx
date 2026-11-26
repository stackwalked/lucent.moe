import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { Refused } from "../../server/outcome.ts";
import { Button } from "../../ui/Button/Button.tsx";
import { Field } from "../../ui/Field/Field.tsx";
import { Page } from "../../ui/Page/Page.tsx";
import { Stack } from "../../ui/Stack/Stack.tsx";
import { TextField } from "../../ui/TextField/TextField.tsx";
import { RefusalNote } from "../auth/RefusalNote.tsx";
import { postingNote } from "../comments/posting.ts";
import { TextArea } from "../comments/TextArea.tsx";
import { AVATAR_ACCEPT, uploadAvatar } from "./avatar.ts";
import { BANNER_ACCEPT, uploadBanner } from "./banner.ts";
import { PROFILE_COPY as C } from "./copy.ts";
import { removeAvatar, removeBanner, saveBio, saveTagline } from "./server.ts";
import { PROFILE_TITLE } from "./title.ts";

const route = getRouteApi("/_member/account/profile");

// The member's own profile as they write it: picture, banner, tagline and about. Plain; the
// page others see is /members/<username>.
export function ProfileEditPage() {
    const outcome = route.useLoaderData();
    const router = useRouter();
    const [refused, setRefused] = useState<Refused | null>(null);
    const [taglineRefused, setTaglineRefused] = useState<Refused | null>(null);
    const [pictureRefused, setPictureRefused] = useState<Refused | null>(null);
    const [bannerRefused, setBannerRefused] = useState<Refused | null>(null);
    const answered = async (reply: { readonly ok: boolean }) => {
        if (reply.ok) await router.invalidate();
    };
    const save = async (form: FormData) => {
        const reply = await saveBio({ data: { bio: String(form.get("bio") ?? "") } });
        setRefused(reply.ok ? null : reply.refused);
        await answered(reply);
    };
    const saveTag = async (form: FormData) => {
        const reply = await saveTagline({ data: { tagline: String(form.get("tagline") ?? "") } });
        setTaglineRefused(reply.ok ? null : reply.refused);
        await answered(reply);
    };
    const sendPicture = async (form: FormData) => {
        const file = form.get("picture");
        if (!(file instanceof File) || file.size === 0) return;
        const reply = await uploadAvatar(file);
        setPictureRefused(reply.ok ? null : reply.refused);
        await answered(reply);
    };
    const takeDownPicture = async () => {
        const reply = await removeAvatar();
        setPictureRefused(reply.ok ? null : reply.refused);
        await answered(reply);
    };
    const sendBanner = async (form: FormData) => {
        const file = form.get("banner");
        if (!(file instanceof File) || file.size === 0) return;
        const reply = await uploadBanner(file);
        setBannerRefused(reply.ok ? null : reply.refused);
        await answered(reply);
    };
    const takeDownBanner = async () => {
        const reply = await removeBanner();
        setBannerRefused(reply.ok ? null : reply.refused);
        await answered(reply);
    };
    if (!outcome.ok) {
        return (
            <Page title={PROFILE_TITLE} width="narrow">
                <RefusalNote refused={outcome.refused} />
            </Page>
        );
    }
    const profile = outcome.value;
    const pictureNote = postingNote(pictureRefused);
    const bioNote = postingNote(refused);
    return (
        <Page
            title={PROFILE_TITLE}
            width="narrow"
            actions={
                <Link to="/members/$username" params={{ username: profile.username }}>
                    {C.yourProfile}
                </Link>
            }
        >
            <Stack gap={6}>
                <form action={sendPicture} key={profile.avatar?.large ?? "none"}>
                    <Stack gap={3}>
                        <RefusalNote
                            refused={pictureRefused}
                            {...(pictureNote === undefined ? {} : { extra: pictureNote })}
                        />
                        <Field label={C.picture} hint={C.pictureHint}>
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
                            <Button type="submit">{C.upload}</Button>{" "}
                            {profile.avatar === null ? null : (
                                <Button tone="danger" onClick={takeDownPicture}>
                                    {C.removePicture}
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
                        <Field label={C.banner} hint={C.pictureHint}>
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
                            <Button type="submit">{C.upload}</Button>{" "}
                            {profile.banner === null ? null : (
                                <Button tone="danger" onClick={takeDownBanner}>
                                    {C.removeBanner}
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
                            label={C.tagline}
                            hint={C.taglineHint}
                            maxLength={80}
                            defaultValue={profile.tagline}
                        />
                        <div>
                            <Button type="submit">{C.save}</Button>
                        </div>
                    </Stack>
                </form>
                <form action={save} key={profile.bio}>
                    <Stack gap={3}>
                        <RefusalNote
                            refused={refused}
                            {...(bioNote === undefined ? {} : { extra: bioNote })}
                        />
                        <TextArea
                            name="bio"
                            label={C.bio}
                            maxLength={500}
                            defaultValue={profile.bio}
                        />
                        <div>
                            <Button type="submit">{C.save}</Button>
                        </div>
                    </Stack>
                </form>
            </Stack>
        </Page>
    );
}
