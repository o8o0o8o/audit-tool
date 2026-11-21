/**
 * The page record (design §2 "Row parts"): core fields as columns, the full analyzer record in
 * `sections`. Written as NDJSON chunks of PAGE_CHUNK_SIZE by buildAuditModel and loaded into `pages`.
 */
import { z } from 'zod';

export const PAGE_CHUNK_SIZE = 500;

const int = z.number().int().nullable();

export const PageRecord = z.object({
  url: z.string(),
  finalUrl: z.string().nullable(),
  statusCode: int,
  blocked: z.boolean().describe('Answered 401/403/429 or a bot challenge; its findings were dropped'),
  segment: z.string().nullable(),
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonical: z.string().nullable(),
  h1: z.array(z.string()),
  lang: z.string().nullable(),
  indexable: z.boolean().nullable(),
  inSitemap: z.boolean().nullable(),
  depth: int.default(null).describe('Path depth of the URL'),
  wordCount: int,
  schemaTypes: z.array(z.string()),
  ttfbMs: int,
  lcpMs: int,
  cls: z.number().nullable(),
  fcpMs: int,
  inpMs: int,
  tbtMs: int,
  speedIndexMs: int.default(null),
  lcpElement: z.string().nullable().default(null).describe('Selector of the largest contentful element (lab run)'),
  bytes: int,
  weight: z
    .object({
      totalBytes: int,
      imageBytes: int,
      thirdPartyBytes: int,
      requestsByType: z.record(z.string(), z.number()).nullable(),
    })
    .nullable()
    .default(null)
    .describe('Transfer size as the crawl recorded it; bytes per resource type are not recorded'),
  requests: int,
  selectionReason: z.string().nullable().describe('Quick scans: why the page was picked'),
  sections: z.record(z.string(), z.unknown()).describe('The full page record as the analyzers wrote it'),
});
export type PageRecord = z.infer<typeof PageRecord>;

/** The run-level data the HTML report is rendered from (stored in `audit_run_data`). */
export const RunData = z.object({
  manifest: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  analysis: z.record(z.string(), z.unknown()),
  'incoming-links': z.record(z.string(), z.unknown()),
});
export type RunData = z.infer<typeof RunData>;
