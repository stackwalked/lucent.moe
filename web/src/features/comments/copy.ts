export const COMMENTS_COPY = {
    title: "comments",
    none: "no comments yet.",
    body: "comment",
    post: "post",
    you: "you",
    time: "posted",
    seePrivacy: "see privacy for what applies to your account.",
    author: (name: string | null) => name ?? "—",
} as const;
