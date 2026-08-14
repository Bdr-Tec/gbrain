// Guard self-test fixture (known-GOOD): the safe text-hop spelling — binds as
// text, the cast parses it (no direct )}::jsonb adjacency).
declare const sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown>;
declare const obj: { get: () => unknown };
export async function good(): Promise<void> {
  await sql`UPDATE pages SET frontmatter = ${JSON.stringify(obj.get())}::text::jsonb WHERE id = 1`;
}
