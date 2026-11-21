/**
 * Derived check types that today's rule would not create: the title is an error message or holds a
 * URL, a file path or mostly digits (`deriveCode` gives `untyped` for it). Lists them with the
 * number of findings that use each; with --apply, sets those findings (rows and site documents) to
 * `untyped`, keeps their titles, and deletes the check types.
 *   yarn --cwd web tsx scripts/clean-derived-codes.ts [--apply]
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { auditDocuments, checkTypeAliases, checkTypes, findings } from '../db/schema';
import { UNTYPED, deriveCode } from '@model/finding-codes';

async function main(): Promise<void> {
  const db = getDb();
  const apply = process.argv.includes('--apply');
  const derived = await db.select().from(checkTypes).where(eq(checkTypes.derived, true));
  const bad = derived.filter((c) => deriveCode(c.title).code !== c.code);
  if (!bad.length) {
    console.log(`${derived.length} derived check types, none to clean`);
    await closeDb();
    return;
  }
  const codes = bad.map((c) => c.code);
  const used = await db
    .select({ code: findings.code, n: sql<number>`count(*)::int` })
    .from(findings)
    .where(inArray(findings.code, codes))
    .groupBy(findings.code);
  const uses = new Map(used.map((u) => [u.code, u.n]));
  for (const c of bad) console.log(`${uses.get(c.code) ?? 0} finding(s)  ${c.code}  "${c.title.slice(0, 100)}"`);
  if (!apply) {
    console.log(`${bad.length} of ${derived.length} derived check types would be removed; run with --apply`);
    await closeDb();
    return;
  }
  const drop = new Set(codes);
  const keep = (code: string) => (drop.has(code) ? UNTYPED : code);
  await db.transaction(async (tx) => {
    const touched = await tx
      .selectDistinct({ auditId: findings.auditId })
      .from(findings)
      .where(inArray(findings.code, codes));
    for (const { auditId } of touched) {
      const [row] = await tx.select().from(auditDocuments).where(eq(auditDocuments.auditId, auditId));
      const doc = row?.document as
        | { findings?: Array<{ code: string }>; recommendations?: Array<{ codes: string[] }> }
        | undefined;
      if (!doc) continue;
      await tx
        .update(auditDocuments)
        .set({
          document: {
            ...doc,
            findings: (doc.findings ?? []).map((f) => ({ ...f, code: keep(f.code) })),
            recommendations: (doc.recommendations ?? []).map((r) => ({
              ...r,
              codes: [...new Set((r.codes ?? []).map(keep))],
            })),
          },
        })
        .where(eq(auditDocuments.auditId, auditId));
    }
    await tx.update(findings).set({ code: UNTYPED }).where(inArray(findings.code, codes));
    for (const code of codes)
      await tx.execute(
        sql`update recommendations set codes = array_replace(codes, ${code}, ${UNTYPED}) where codes @> array[${code}]::text[]`,
      );
    await tx.delete(checkTypeAliases).where(inArray(checkTypeAliases.code, codes));
    await tx.delete(checkTypes).where(inArray(checkTypes.code, codes));
  });
  console.log(`removed ${bad.length} derived check types`);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
