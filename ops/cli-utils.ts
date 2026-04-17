export function readFlag(name: string, argv: readonly string[] = process.argv): string | undefined {
  const prefixed = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefixed))?.slice(prefixed.length);
}

export function buildBunToolCommand(tool: string, args: readonly string[]): string[] {
  return ['bun', 'x', tool, ...args];
}
