// The one read of this process's environment (ast-grep: ts-no-ambient-env). A child a test
// spawns gets it plus its own variables: an empty environment breaks it in ways unrelated to the
// test (Windows sockets need SystemRoot).
export function inheritedEnvironment(): Readonly<Record<string, string | undefined>> {
    return { ...process.env };
}
