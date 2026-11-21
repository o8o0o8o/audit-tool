/**
 * The AuditModel (docs/platform-api.md §2). Zod only — no fs, no Playwright — so web/ can import it
 * through the `@model/*` alias. The full site and lead-summary schemas arrive in step 3.
 */
import { z } from 'zod';

export const MODEL_VERSION = '0.1.0';

/** A model version string, `major.minor.patch`. The loader refuses an unknown major. */
export const ModelVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .describe('AuditModel version, major.minor.patch');

export function modelMajor(version: string): number {
  return Number(ModelVersion.parse(version).split('.')[0]);
}
