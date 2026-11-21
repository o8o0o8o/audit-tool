/**
 * Platform steps around the audit (design §8.4): fingerprint after every audit, truth gate after
 * standard-profile quick scans, secrets masking, model build. The audit itself is unchanged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeAuditModel } from '../model/build/build-audit-model';
import { normalizeRunOptions } from '../model/run-options';
import { maskSecretsInRun } from './mask-secrets';
import type { PlatformSteps, StepContext } from './run';

async function fingerprint(ctx: StepContext): Promise<void> {
  const { fingerprintSite } = await import('../leads/fingerprint');
  const origin = new URL(ctx.audit.target_url).origin;
  const result = await fingerprintSite(origin);
  mkdirSync(path.join(ctx.runDir, 'platform'), { recursive: true });
  writeFileSync(path.join(ctx.runDir, 'platform', 'stack.json'), JSON.stringify(result, null, 2));
}

async function gate(ctx: StepContext): Promise<void> {
  if (ctx.audit.mode !== 'quick' || ctx.audit.profile !== 'standard') return;
  const [
    { loadRun },
    { runGate, GATE_DEFAULTS },
    { buildLeadFile, gateRunStamp, leadDir, writeLeadFile },
    { httpPageFetcher },
    { defaultDohResolvers },
    { PlaywrightGateBrowser },
    { readSuspended },
  ] = await Promise.all([
    import('../leads/run-data'),
    import('../leads/truth-gate'),
    import('../leads/lead-file'),
    import('../leads/fingerprint'),
    import('../leads/doh'),
    import('../leads/gate-browser'),
    import('../leads/review-log'),
  ]);
  const { readFileSync } = await import('node:fs');
  let stack = null;
  try {
    stack = JSON.parse(readFileSync(path.join(ctx.runDir, 'platform', 'stack.json'), 'utf8')).profile ?? null;
  } catch {
    /* no fingerprint */
  }
  const run = loadRun(ctx.runDir);
  const runStamp = gateRunStamp(new Date().toISOString());
  const browser = new PlaywrightGateBrowser(path.join(leadDir(ctx.runDir), 'evidence', runStamp), leadDir(ctx.runDir));
  try {
    // gate-suspended.json is read from the checkout (design §8.13).
    const suspended = Object.keys(readSuspended(path.join(ctx.repoRoot, 'docs/gtm/gate-suspended.json')));
    const result = await runGate(
      run,
      stack,
      { get: httpPageFetcher, browser, dns: defaultDohResolvers() },
      { minCauses: GATE_DEFAULTS.minCauses, suspendedTypes: suspended },
    );
    const lead = buildLeadFile({
      domain: ctx.audit.host,
      company: ctx.audit.host,
      run,
      stack,
      gate: result,
      fitScore: null,
      scannedAt: new Date().toISOString(),
      runStamp,
    });
    writeLeadFile(lead);
  } finally {
    await browser.close();
  }
}

async function mask(ctx: StepContext): Promise<void> {
  // The whole run folder, before the model and the raw archive are built from it.
  const record = maskSecretsInRun(ctx.runDir, undefined, {
    quarantineDir: path.join(path.dirname(ctx.runDir), '.not-masked', path.basename(ctx.runDir)),
  });
  const all = Object.values(record);
  const failed = all.filter((r) => r.notMasked).length;
  if (all.length) console.log(`[worker] masked secrets in ${all.length - failed} stored file(s)`);
  if (failed) console.log(`[worker] ${failed} file(s) could not be masked and are not stored`);
}

async function build(ctx: StepContext): Promise<void> {
  const options = normalizeRunOptions(ctx.audit.mode, ctx.audit.options);
  const { doc } = writeAuditModel({
    runDir: ctx.runDir,
    auditId: ctx.audit.audit_id,
    mode: ctx.audit.mode,
    profile: ctx.audit.profile,
    preset: options.preset,
  });
  console.log(`[worker] model built: ${doc.findings.length} findings, scan ${doc.scanQuality.state}`);
}

export function platformSteps(): PlatformSteps {
  return { fingerprint, gate, mask, build };
}
