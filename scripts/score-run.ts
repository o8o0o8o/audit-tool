/**
 * Scores a run folder with the current scoring code and prints the summary as JSON. The platform
 * re-scores stored audits with it when the scoring code changes (web/lib/core/rescore.ts), so the
 * scores in the database, the API and every report agree.
 *   npx tsx scripts/score-run.ts --run=<run dir>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ReportDataProcessor } from '../lib/reports/data-processor';
import { ScoreCalculator } from '../lib/scoring/score-calculator';
import type { AnalysisDetail, PageData, PageInfo } from '../lib/types';

const runDir = path.resolve(process.argv.find((a) => a.startsWith('--run='))?.slice(6) ?? '');
const manifest = path.join(runDir, 'manifest.json.gz');
const domain = (JSON.parse(gunzipSync(readFileSync(manifest)).toString()) as { domain?: string }).domain ?? 'site';
const log = console.log;
console.log = () => {}; // the data loader logs progress; stdout carries only the JSON
const data = ReportDataProcessor.prepareReportData(manifest, domain);
const jsonData = data.jsonData as { analysis?: { details?: Record<string, AnalysisDetail>; bySeverity?: Record<string, string[]> }; cruxData?: unknown };
const details = jsonData.analysis?.details ?? {};
const bySeverity: Record<string, string[]> = { critical: [], high: [], medium: [], low: [], ...(jsonData.analysis?.bySeverity ?? {}) };
const pageData = data.pageData as PageData;
const summary = ScoreCalculator.calculateSummary({ bySeverity, details }, pageData, (pageData.pages ?? {}) as Record<string, PageInfo>, jsonData.cruxData);
log(JSON.stringify({ overallScore: summary.overallScore, categoryScores: summary.categoryScores, performanceSource: summary.performanceSource }));
