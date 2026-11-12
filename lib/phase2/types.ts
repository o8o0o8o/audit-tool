/**
 * Shape of artifacts consumed by the Phase 2 runner.
 *
 * These mirror what the Phase 1 crawl writes to disk (manifest.json.gz,
 * analysis.json.gz, metadata.json.gz). We keep these definitions narrow on
 * purpose — Phase 2 needs only a subset of Phase 1's data.
 */

export interface ManifestData {
  version: number;
  format: string;
  domain: string;
  created: string;
  progress: {
    processedPages: string[];
    totalWithoutError: number;
    totalWithError: number;
    byError: Record<string, unknown>;
    attempts: Record<string, unknown>;
  };
  files: {
    metadata: string;
    analysis: string;
    incomingLinks: string;
    pageBatches: Array<{ file: string; count: number; urls: string[] }>;
  };
  evidence?: Record<string, { url: string | null; files: string[] }> | null;
}

export interface IssueDetail {
  severity: string; // 'critical' | 'high' | 'medium' | 'low'
  count: number;
  examples: string[];
  truncated?: boolean;
  /** Set when this finding came from the optional LLM anomaly pass rather
   *  than a deterministic analyzer, so the report can label it. */
  aiDiscovered?: boolean;
  /** Remediation text supplied by the anomaly pass (used as the Fix). */
  recommendation?: string;
}

export interface QuickWin {
  issue: string;
  severity: string;
  affectedPages: number;
  impact: string;
  effort: string;
  effortMinutes?: number;
  fix: string;
  example?: string;
  examples?: string[];
  resources?: Array<{ text: string; url: string }>;
  impactScore?: number;
}

export interface AnalysisData {
  overall: string[];
  details: Record<string, IssueDetail>;
  bySeverity: Record<string, string[]>;
  summary: {
    totalIssues: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    categoryScores: Record<string, number>;
    overallScore: number;
    passRate: number;
    quickWins: QuickWin[];
  };
}

export interface MetadataData {
  robots?: unknown;
  sitemaps?: { total?: number; urls?: Record<string, unknown> };
  isMultiLang?: boolean;
  timing?: Record<string, number>;
  cruxData?: unknown;
  /** True when the crawl ran the `--visual` analyzers on every page. */
  visual?: boolean;
}

export interface AuditArtifacts {
  runDir: string;
  manifest: ManifestData;
  analysis: AnalysisData;
  metadata: MetadataData;
  /** Optional — present only when --repo was passed and repo-analysis succeeded. */
  repoAnalysis?: RepoAnalysisData | null;
}

/** One mapped source location for a finding (from --repo source mapping). */
export interface SourceLocation {
  file: string;
  line?: number;
  context?: string;
  suggestion?: string;
}

export interface RepoAnalysisData {
  framework?: string | null;
  version?: string | null;
  router?: string | null;
  configFile?: string | null;
  /** Maps a finding message → the source files implicated, with fix hints. */
  sourceMapping?: Record<string, SourceLocation[]> | null;
}
