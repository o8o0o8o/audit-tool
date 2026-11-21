/**
 * Checkpoint snapshots (§3 "Writes during a run", §8.6): after a checkpoint save completes, every
 * file of the results folder is uploaded content-addressed (`objects/<sha256>`) with a manifest;
 * only files whose hash has not been uploaded in this attempt go up, so evidence goes up once.
 * What is uploaded is a masked copy (design §8.14): the audit keeps reading its own files, and the
 * manifest's hash is that of the stored bytes, so a restore checks what it reads.
 * A redispatched worker restores the newest snapshot into its own work folder and runs --proceed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppClient, SnapshotManifest, UploadGrant } from './client';
import { maskFileBytes } from './mask-secrets';

export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export class Snapshotter {
  private uploaded = new Set<string>();
  /** sha256 of a file as read → sha256 and size of its masked copy, so a file is masked once. */
  private stored = new Map<string, { sha256: string; bytes: number }>();
  private grant: { current: UploadGrant; area: 'checkpoint' } | null = null;
  lastAt = 0;
  count = 0;

  constructor(
    private readonly client: AppClient,
    private readonly workDir: string,
    private readonly base: string,
    private readonly auditId: string,
    private readonly attempt: number,
  ) {}

  /** Takes one snapshot. Returns false when a file changed mid-read (a save was running); try later. */
  async take(isStable: () => boolean): Promise<boolean> {
    const root = path.join(this.workDir, this.base);
    const files = walkFiles(root);
    if (!files.length) return false;
    const entries: SnapshotManifest['files'] = [];
    const bodies = new Map<string, Uint8Array>();
    const seen = new Map<string, { sha256: string; bytes: number }>();
    for (const f of files) {
      let body: Buffer;
      try {
        body = readFileSync(f);
      } catch {
        return false; // removed or replaced by a running save
      }
      const rel = path.relative(this.workDir, f).split(path.sep).join('/');
      const original = createHash('sha256').update(body).digest('hex');
      let known = this.stored.get(original) ?? seen.get(original);
      if (!known) {
        let masked: Buffer;
        try {
          masked = maskFileBytes(rel, body).body;
        } catch (err) {
          if (f.endsWith('.json.gz')) return false; // half-written checkpoint file
          // A file that cannot be masked is not stored; the resumed run does without it.
          console.log(`[worker] snapshot leaves out ${rel}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        known = { sha256: createHash('sha256').update(masked).digest('hex'), bytes: masked.byteLength };
        seen.set(original, known);
        if (!this.uploaded.has(known.sha256)) bodies.set(known.sha256, masked);
      }
      entries.push({ path: rel, sha256: known.sha256, bytes: known.bytes });
    }
    if (!isStable()) return false;
    this.grant ??= { current: await this.client.uploadGrant('checkpoint'), area: 'checkpoint' };
    const prefix = `checkpoints/${this.auditId}/${this.attempt}/`;
    for (const [sha, body] of bodies) {
      await this.client.upload(this.grant, `${prefix}objects/${sha}`, body);
      this.uploaded.add(sha);
    }
    for (const [original, known] of seen) this.stored.set(original, known);
    const manifest: SnapshotManifest = { takenAt: new Date().toISOString(), base: this.base, files: entries };
    await this.client.upload(
      this.grant,
      `${prefix}manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
      'application/json',
    );
    this.lastAt = Date.now();
    this.count++;
    return true;
  }
}

/** Restores a snapshot into the work folder; returns the number of files written. */
export async function restoreSnapshot(
  client: AppClient,
  workDir: string,
  snap: { attempt: number; manifest: SnapshotManifest },
): Promise<number> {
  let n = 0;
  for (const f of snap.manifest.files) {
    if (f.path.split('/').includes('..') || path.isAbsolute(f.path)) throw new Error(`bad snapshot path ${f.path}`);
    const body = await client.snapshotObject(snap.attempt, f.sha256);
    if (createHash('sha256').update(body).digest('hex') !== f.sha256)
      throw new Error(`snapshot object ${f.sha256} is corrupt`);
    const dest = path.join(workDir, f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, body);
    n++;
  }
  return n;
}

export function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
