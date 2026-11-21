/**
 * Checkpoint snapshots (§3 "Writes during a run", §8.6): after a checkpoint save completes, every
 * file of the results folder is uploaded content-addressed (`objects/<sha256>`) with a manifest;
 * only files whose hash has not been uploaded in this attempt go up, so evidence goes up once.
 * A redispatched worker restores the newest snapshot into its own work folder and runs --proceed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import type { AppClient, SnapshotManifest, UploadGrant } from './client';

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
    for (const f of files) {
      const body = readFileSync(f);
      if (f.endsWith('.json.gz')) {
        try {
          gunzipSync(body);
        } catch {
          return false; // half-written checkpoint file
        }
      }
      const sha = createHash('sha256').update(body).digest('hex');
      entries.push({
        path: path.relative(this.workDir, f).split(path.sep).join('/'),
        sha256: sha,
        bytes: body.byteLength,
      });
      if (!this.uploaded.has(sha)) bodies.set(sha, body);
    }
    if (!isStable()) return false;
    this.grant ??= { current: await this.client.uploadGrant('checkpoint'), area: 'checkpoint' };
    const prefix = `checkpoints/${this.auditId}/${this.attempt}/`;
    for (const [sha, body] of bodies) {
      await this.client.upload(this.grant, `${prefix}objects/${sha}`, body);
      this.uploaded.add(sha);
    }
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
