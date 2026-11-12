/**
 * Finds cloud storage buckets referenced by the site's assets (Amazon S3,
 * Google Cloud Storage, Azure Blob) and checks whether each one lets anyone
 * list its contents. One GET per bucket, at most 10 buckets.
 */

import { SEVERITY } from '../../constants';
import type { Issue } from '../../types';
import { escapeHtml } from '../../utils';
import { defaultHttpFetcher, plural, runPool, type HttpProbeFetcher } from './http-probe';
import type { SiteProbeResult } from './site-checks-types';

const MAX_BUCKETS = 10;
const CONCURRENCY = 3;

export type BucketProvider = 's3' | 'gcs' | 'azure';

export interface BucketRef {
  provider: BucketProvider;
  /** bucket name, or `<account>/<container>` for Azure. */
  name: string;
  listUrl: string;
}

const S3_WEBSITE = /^(.+)\.s3-website[.-]([a-z0-9-]+)\.amazonaws\.com$/;
const S3_VIRTUAL = /^(.+)\.s3(?:[.-](?:dualstack\.)?([a-z0-9-]+))?\.amazonaws\.com$/;
const S3_PATH = /^s3(?:[.-](?:dualstack\.)?([a-z0-9-]+))?\.amazonaws\.com$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.\-_]{1,221}[a-z0-9]$/;

function s3ListUrl(bucket: string, region?: string): string {
  const host = region && region !== 'external-1' ? `s3.${region}.amazonaws.com` : 's3.amazonaws.com';
  // Dotted bucket names break the wildcard TLS cert in virtual-host style.
  return bucket.includes('.') ? `https://${host}/${bucket}/` : `https://${bucket}.${host}/`;
}

/** Parses one URL into a bucket reference, or null. */
export function bucketFromUrl(raw: string): BucketRef | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = decodeURIComponent(u.pathname.split('/')[1] ?? '').toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = S3_WEBSITE.exec(host))) return { provider: 's3', name: m[1], listUrl: s3ListUrl(m[1], m[2]) };
  if ((m = S3_PATH.exec(host))) {
    return seg && BUCKET_NAME.test(seg) ? { provider: 's3', name: seg, listUrl: s3ListUrl(seg, m[1]) } : null;
  }
  if ((m = S3_VIRTUAL.exec(host))) return { provider: 's3', name: m[1], listUrl: s3ListUrl(m[1], m[2]) };
  if (host === 'storage.googleapis.com') {
    return seg && BUCKET_NAME.test(seg)
      ? { provider: 'gcs', name: seg, listUrl: `https://storage.googleapis.com/${seg}` }
      : null;
  }
  if ((m = /^(.+)\.storage\.googleapis\.com$/.exec(host))) {
    return { provider: 'gcs', name: m[1], listUrl: `https://storage.googleapis.com/${m[1]}` };
  }
  if ((m = /^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/.exec(host))) {
    if (!seg || !/^[a-z0-9$][a-z0-9-]{1,62}$/.test(seg)) return null;
    return {
      provider: 'azure',
      name: `${m[1]}/${seg}`,
      listUrl: `https://${host}/${seg}?restype=container&comp=list`,
    };
  }
  return null;
}

/** Deduped buckets referenced by `urls`, capped at 10. */
export function extractBuckets(urls: Iterable<string>, limit = MAX_BUCKETS): BucketRef[] {
  const out = new Map<string, BucketRef>();
  for (const raw of urls) {
    if (out.size >= limit) break;
    const b = bucketFromUrl(raw);
    if (b && !out.has(`${b.provider}:${b.name}`)) out.set(`${b.provider}:${b.name}`, b);
  }
  return [...out.values()];
}

/** Number of objects in a public listing response, or -1 when the body is not a listing. */
export function listingObjectCount(body: string): number {
  if (/<ListBucketResult[\s>]/.test(body)) return (body.match(/<Key>/g) ?? []).length;
  if (/<EnumerationResults[\s>]/.test(body)) return (body.match(/<Blob>/g) ?? []).length;
  if (/"kind"\s*:\s*"storage#objects"/.test(body)) return (body.match(/"kind"\s*:\s*"storage#object"/g) ?? []).length;
  return -1;
}

const PROVIDER_NAME: Record<BucketProvider, string> = {
  s3: 'Amazon S3',
  gcs: 'Google Cloud Storage',
  azure: 'Azure Blob Storage',
};

export class OpenBucketProbe {
  static async probe(
    assetUrls: Iterable<string>,
    fetcher: HttpProbeFetcher = defaultHttpFetcher,
  ): Promise<SiteProbeResult> {
    const buckets = extractBuckets(assetUrls);
    const open: Array<{ b: BucketRef; count: number }> = [];
    let answered = 0;
    await runPool(buckets, CONCURRENCY, async (b) => {
      const res = await fetcher(b.listUrl, { maxBytes: 128 * 1024 });
      if (!res) return;
      answered++;
      if (res.status !== 200) return;
      const count = listingObjectCount(res.body);
      if (count >= 0) open.push({ b, count });
    });

    const issues: Issue[] = [];
    if (open.length) {
      const list = open
        .map(
          ({ b, count }) =>
            `${escapeHtml(b.name)} (${PROVIDER_NAME[b.provider]}, ${escapeHtml(b.listUrl)}${count ? `, ${count}+ objects listed` : ''})`,
        )
        .join('; ');
      issues.push({
        message: 'Cloud storage bucket allows public listing',
        detail: `Anyone can list every file in ${open.length > 1 ? 'these buckets' : 'this bucket'}, including files the site never links to: ${list}. Remove the public list permission (S3: s3:ListBucket; GCS: storage.objects.list for allUsers; Azure: container access level "Blob" instead of "Container"); keep public read on objects only if needed.`,
        severity: SEVERITY.HIGH,
      });
    }

    return {
      issues,
      checks: [
        {
          id: 'open-buckets',
          label: 'Cloud storage buckets',
          status: open.length ? 'fail' : !buckets.length || !answered ? 'skipped' : 'pass',
          note: open.length
            ? `${plural(open.length, 'bucket')} publicly listable`
            : !buckets.length
              ? 'no cloud storage buckets referenced'
              : !answered
                ? 'buckets did not respond'
                : `${plural(buckets.length, 'bucket')} checked`,
        },
      ],
    };
  }
}
