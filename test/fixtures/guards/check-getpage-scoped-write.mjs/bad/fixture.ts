// BAD: unscoped existence check + default-scoped write in one file.
export async function badNoOpts(engine: any, slug: string): Promise<void> {
  const existing = await engine.getPage(slug);
  if (!existing) await engine.putPage(slug, { title: 'x' });
}
// BAD: conditional-undefined read (any-source when unset) + write via importFromContent.
export async function badTernary(engine: any, slug: string, sourceId?: string): Promise<void> {
  const existing = await engine.getPage(slug, sourceId ? { sourceId } : undefined);
  if (!existing) await importFromContent(engine, slug, '# x', { sourceId });
}
declare function importFromContent(...args: unknown[]): Promise<unknown>;
