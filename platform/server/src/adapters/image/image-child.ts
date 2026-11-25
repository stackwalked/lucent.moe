import { runAvatarChild } from "./transcode.ts";

// The decoder child's entry: `bun image-child.ts`, started by image.ts with an empty environment
// and a deadline. It reads the upload from stdin, writes one frame (frame.ts) to stdout and exits;
// it opens no file but its own code and the codecs' WebAssembly, and no socket.
await runAvatarChild();
