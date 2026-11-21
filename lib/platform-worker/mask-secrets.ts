/**
 * No unmasked secrets in stored files (design §8.14). Before upload, every text file the worker is
 * about to store is run through the JS-secrets scanner's patterns and the matches are masked. The
 * recorded sha256 stays that of the original answer; `platform/masked.json` notes what was masked.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findSecrets, maskSecret } from '../analyzers/site-checks/js-secrets-scanner';
import { walkFiles } from './snapshot';

const TEXT = /\.(html?|js|mjs|cjs|json|txt|md|css|xml|svg|csv)$/i;
const MAX_BYTES = 20 * 1024 * 1024;

export interface MaskRecord {
  sha256Original: string;
  masked: number;
  patterns: string[];
}

export function maskText(text: string): { text: string; masked: number; patterns: string[] } {
  const found = findSecrets(text);
  let out = text;
  for (const m of found) out = out.split(m.secret).join(maskSecret(m.secret));
  return { text: out, masked: found.length, patterns: [...new Set(found.map((f) => f.patternId))] };
}

/** Masks secrets in the stored text files of a run (evidence, gate evidence, reports). */
export function maskSecretsInRun(runDir: string, dirs = ['evidence', 'lead', '.']): Record<string, MaskRecord> {
  const record: Record<string, MaskRecord> = {};
  const files = new Set<string>();
  for (const d of dirs) {
    const abs = path.join(runDir, d);
    for (const f of d === '.' ? walkFiles(abs).filter((x) => path.dirname(x) === runDir) : walkFiles(abs)) files.add(f);
  }
  for (const f of files) {
    if (!TEXT.test(f)) continue;
    const body = readFileSync(f);
    if (body.byteLength > MAX_BYTES) continue;
    const { text, masked, patterns } = maskText(body.toString('utf8'));
    if (!masked) continue;
    const rel = path.relative(runDir, f).split(path.sep).join('/');
    record[rel] = { sha256Original: createHash('sha256').update(body).digest('hex'), masked, patterns };
    writeFileSync(f, text);
  }
  if (Object.keys(record).length) {
    mkdirSync(path.join(runDir, 'platform'), { recursive: true });
    writeFileSync(path.join(runDir, 'platform', 'masked.json'), JSON.stringify(record, null, 2));
  }
  return record;
}

export function readMaskRecord(runDir: string): Record<string, MaskRecord> {
  try {
    return JSON.parse(readFileSync(path.join(runDir, 'platform', 'masked.json'), 'utf8')) as Record<string, MaskRecord>;
  } catch {
    return {};
  }
}
