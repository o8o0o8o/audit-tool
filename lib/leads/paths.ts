/**
 * Where the lead pipeline keeps its files. Lead scans never write under `audit-results/`:
 * that folder holds full audits only, so resume (`--proceed`), history and comparisons there
 * can never pick up a lead scan.
 */

import * as path from 'node:path';
import { LEAD_MODE } from '../args-parser';

/** The one place lead scans are written (`start.ts --lead` has no option to change it). */
export const LEAD_RESULTS_DIR: string = LEAD_MODE.resultsBase;

export const leadDomainDir = (domain: string, base: string = LEAD_RESULTS_DIR) => path.join(base, domain);

export const stackJsonPath = (domain: string, base: string = LEAD_RESULTS_DIR) =>
  path.join(leadDomainDir(domain, base), 'stack.json');
