// The options of the `bayma` binary's commands, each given once, as a name and
// its value.

export function parseCliOptions(
  args: string[],
  allowedNames: readonly string[],
): ReadonlyMap<string, string> {
  const allowed = new Set(allowedNames);
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`unknown option ${name}`);
    if (parsed.has(name))
      throw new Error(`option ${name} may be provided only once`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${name} requires one value`);
    }
    parsed.set(name, value);
  }
  return parsed;
}
