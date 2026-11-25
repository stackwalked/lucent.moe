// A decoder child that hangs: it never reads its input, never writes and never exits, as a codec
// stuck in a loop would. The timer keeps the process alive until the parent kills it.
setInterval(() => undefined, 60_000);
