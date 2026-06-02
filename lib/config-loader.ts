/**
 * Config Loader
 * Loads and merges configuration from files and CLI arguments
 */

import * as fs from 'fs';
import * as path from 'path';

/** Typed config object - supports partial user configs and merged results */
interface ConfigRecord {
  thresholds?: Record<string, number>;
  crawl?: {
    concurrency?: number;
    timeout?: number;
    retryAttempts?: number;
    userAgent?: string | null;
    headers?: Record<string, string> | null;
    batchSize?: number;
    maxDiscoveredUrls?: number;
    [key: string]: unknown;
  };
  queryParams?: {
    mode?: string;
    whitelist?: string[];
    blacklist?: string[];
    [key: string]: unknown;
  };
  excludeUrls?: string[];
  includeUrls?: string[];
  analysis?: {
    similarityThreshold?: number;
    jsUnusedThreshold?: number;
    cssUnusedThreshold?: number;
    maxOutboundChecks?: number;
    outboundTimeout?: number;
    [key: string]: unknown;
  };
  report?: {
    showQuickWins?: boolean;
    maxQuickWins?: number;
    showPerformanceCharts?: boolean;
    [key: string]: unknown;
  };
  apiKeys?: {
    crux?: string | null;
    [key: string]: unknown;
  };
  network?: Record<string, unknown>;
  [key: string]: unknown;
}

const CONFIG_FILE_NAMES = ['.seoauditrc', '.seoauditrc.json', 'seoaudit.config.json'];

/**
 * Default configuration
 *
 * IMPORTANT: Threshold values here MUST match lib/constants.js THRESHOLDS.
 * These serve as configurable overrides - constants.js is the source of truth.
 * When adding new thresholds:
 * 1. Add to lib/constants.js THRESHOLDS first
 * 2. Mirror the same default value here
 * 3. Add to CONFIG_SCHEMA.thresholds.allowedKeys
 *
 * @see lib/constants.js - canonical threshold definitions
 */
const DEFAULT_CONFIG = {
  // Performance thresholds (names aligned with lib/constants.js THRESHOLDS)
  thresholds: {
    TTFB: 800,
    LCP: 2500,
    CLS: 0.1,
    FCP: 1800,
    INP: 200,
    PAGE_SIZE: 6_000_000, // 6MB (bytes)
    REQUEST_COUNT: 20, // Renamed from REQUESTS for consistency with constants.js
    TITLE_MIN: 30,
    TITLE_MAX: 60,
    DESCRIPTION_MIN: 120,
    DESCRIPTION_MAX: 160,
    CONTENT_MIN: 300, // Renamed from MIN_CONTENT_WORDS for consistency
    CONTENT_RECOMMENDED: 600, // Renamed from RECOMMENDED_CONTENT_WORDS for consistency
  },

  // Crawl settings
  crawl: {
    concurrency: 5,
    timeout: 30000,
    retryAttempts: 3,
    userAgent: null, // null → crawler uses DEFAULT_USER_AGENT (realistic mobile Chrome); set to override
    batchSize: 100, // Pages per batch file (higher = fewer files, more memory)
    maxDiscoveredUrls: 100000, // Maximum URLs to discover via link crawling
  },

  // Query parameter handling
  queryParams: {
    mode: 'strip_tracking', // 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist'
    whitelist: ['page', 'id', 'p'], // Params to keep when mode is 'whitelist'
    blacklist: ['color'], // Additional params to strip (beyond tracking params)
  },

  // URL filtering
  excludeUrls: [],
  includeUrls: [], // Empty = include all

  // Content & analysis settings
  analysis: {
    similarityThreshold: 0.6, // Jaccard similarity threshold for near-duplicate detection (0-1)
    jsUnusedThreshold: 50, // % unused JS to flag as issue
    cssUnusedThreshold: 60, // % unused CSS to flag as issue
    maxOutboundChecks: 20, // Max external links to check per page
    outboundTimeout: 5000, // Timeout for outbound link checks (ms)
  },

  // Report settings
  report: {
    showQuickWins: true,
    maxQuickWins: 10,
    showPerformanceCharts: true,
  },

  // API keys
  apiKeys: {
    crux: null, // Google API key for Chrome UX Report
  },
};

/**
 * Load configuration from file
 * @param {string} configPath - Optional explicit config path
 * @returns {Object} Merged configuration
 */
function loadConfig(configPath: string | null = null) {
  let userConfig: ConfigRecord = {};

  // Try explicit path first
  if (configPath) {
    if (fs.existsSync(configPath)) {
      userConfig = loadConfigFile(configPath);
      console.log(`📄 Loaded config from: ${configPath}`);
    } else {
      console.warn(`⚠️  Config file not found: ${configPath}`);
    }
  } else {
    // Try default config file locations
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = path.join(process.cwd(), fileName);
      if (fs.existsSync(filePath)) {
        userConfig = loadConfigFile(filePath);
        console.log(`📄 Loaded config from: ${fileName}`);
        break;
      }
    }
  }

  // Deep merge user config with defaults
  const mergedConfig = deepMerge(DEFAULT_CONFIG, userConfig);

  // Show what was customized
  if (Object.keys(userConfig).length > 0) {
    const customized: string[] = [];
    if (userConfig.thresholds) customized.push(`${Object.keys(userConfig.thresholds).length} threshold(s)`);
    if (userConfig.crawl) customized.push('crawl settings');
    if (userConfig.excludeUrls?.length) customized.push(`${userConfig.excludeUrls.length} URL exclusion(s)`);
    if (userConfig.queryParams) customized.push('query params');
    if (userConfig.analysis) customized.push('analysis settings');
    if (userConfig.report) customized.push('report settings');
    if (customized.length > 0) {
      console.log(`   Custom: ${customized.join(', ')}`);
    }
  }

  // Validate merged config to catch any issues from the merge
  return validateMergedConfig(mergedConfig);
}

/**
 * Load and parse a config file with validation
 * @param {string} filePath - Path to config file
 * @returns {Object} Parsed and validated config
 */
function loadConfigFile(filePath: string) {
  try {
    // Check file size to prevent memory exhaustion (max 1MB)
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      console.error(`❌ Config file too large (${stats.size} bytes, max 1MB): ${filePath}`);
      return {};
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content);

    // Validate and sanitize config
    return validateConfig(config);
  } catch (error: unknown) {
    console.error(`❌ Error parsing config file ${filePath}: ${(error as Error).message}`);
    return {};
  }
}

/**
 * Config schema definition for validation
 * Defines expected types and allowed keys for each section
 */
/**
 * Threshold name aliases for backward compatibility
 * Maps old names to canonical names (used in constants.js)
 */
const THRESHOLD_ALIASES = {
  REQUESTS: 'REQUEST_COUNT',
  MIN_CONTENT_WORDS: 'CONTENT_MIN',
  RECOMMENDED_CONTENT_WORDS: 'CONTENT_RECOMMENDED',
};

const CONFIG_SCHEMA = {
  thresholds: {
    type: 'object',
    // Canonical names (matching constants.js) plus legacy aliases
    allowedKeys: [
      'TTFB',
      'LCP',
      'CLS',
      'FCP',
      'INP',
      'TBT',
      'TTI',
      'PAGE_SIZE',
      'REQUEST_COUNT',
      'REQUESTS', // REQUEST_COUNT is canonical, REQUESTS is alias
      'TITLE_MIN',
      'TITLE_MAX',
      'DESCRIPTION_MIN',
      'DESCRIPTION_MAX',
      'CONTENT_MIN',
      'MIN_CONTENT_WORDS', // CONTENT_MIN is canonical
      'CONTENT_RECOMMENDED',
      'RECOMMENDED_CONTENT_WORDS', // CONTENT_RECOMMENDED is canonical
      'URL_LENGTH_MAX',
      'URL_LENGTH_RECOMMENDED',
      'URL_DEPTH_MAX',
      'IMAGE_SIZE_MAX',
      'RETRY_ATTEMPTS',
      'PAGE_TIMEOUT',
    ],
    valueType: 'number',
  },
  crawl: {
    type: 'object',
    allowedKeys: ['concurrency', 'timeout', 'retryAttempts', 'userAgent', 'headers', 'batchSize', 'maxDiscoveredUrls'],
  },
  queryParams: {
    type: 'object',
    allowedKeys: ['mode', 'whitelist', 'blacklist'],
  },
  excludeUrls: { type: 'array', itemType: 'string' },
  includeUrls: { type: 'array', itemType: 'string' },
  analysis: {
    type: 'object',
    allowedKeys: [
      'similarityThreshold',
      'jsUnusedThreshold',
      'cssUnusedThreshold',
      'maxOutboundChecks',
      'outboundTimeout',
    ],
  },
  report: {
    type: 'object',
    allowedKeys: ['showQuickWins', 'maxQuickWins', 'showPerformanceCharts'],
  },
  apiKeys: {
    type: 'object',
    allowedKeys: ['crux'],
  },
};

/**
 * Validate configuration values
 * @param {Object} config - Raw config object
 * @returns {Object} Validated config with invalid values removed
 */
function validateConfig(config: ConfigRecord) {
  // Deep-clone nested objects to avoid mutating the caller's config
  const validated = { ...config };
  if (validated.thresholds) validated.thresholds = { ...validated.thresholds };
  if (validated.network) validated.network = { ...validated.network };
  if (validated.crawl) validated.crawl = { ...validated.crawl };
  if (validated.analysis) validated.analysis = { ...validated.analysis };
  const warnings: string[] = [];

  // Check for unknown top-level keys
  const allowedTopLevelKeys = new Set(Object.keys(CONFIG_SCHEMA));
  for (const key of Object.keys(config)) {
    if (!allowedTopLevelKeys.has(key)) {
      warnings.push(
        `Unknown config key "${key}" - will be ignored. Valid keys: ${[...allowedTopLevelKeys].join(', ')}`,
      );
      delete validated[key];
    }
  }

  // Validate thresholds (must be positive numbers, check allowed keys)
  if (validated.thresholds) {
    const thresholdSchema = CONFIG_SCHEMA.thresholds;

    // First, normalize aliases to canonical names
    for (const [alias, canonical] of Object.entries(THRESHOLD_ALIASES)) {
      if (alias in validated.thresholds && !(canonical in validated.thresholds)) {
        validated.thresholds[canonical] = validated.thresholds[alias];
        delete validated.thresholds[alias];
        warnings.push(`Threshold "${alias}" renamed to "${canonical}" (using canonical name)`);
      } else if (alias in validated.thresholds && canonical in validated.thresholds) {
        // Both exist - prefer canonical, remove alias
        delete validated.thresholds[alias];
        warnings.push(`Both "${alias}" and "${canonical}" specified - using "${canonical}"`);
      }
    }

    for (const [key, value] of Object.entries(validated.thresholds)) {
      // Skip if it's an alias (already processed above)
      if (key in THRESHOLD_ALIASES) {
        continue;
      }
      // Check if key is allowed
      if (!thresholdSchema.allowedKeys.includes(key)) {
        warnings.push(
          `Unknown threshold "${key}" - will be ignored. Valid thresholds: ${thresholdSchema.allowedKeys.slice(0, 5).join(', ')}...`,
        );
        delete validated.thresholds[key];
        continue;
      }
      // Check value type
      if (typeof value !== 'number' || value < 0 || !Number.isFinite(value)) {
        warnings.push(`Invalid threshold "${key}": ${value} (must be a positive number)`);
        delete validated.thresholds[key];
      }
    }
  }

  // Validate crawl settings
  if (validated.crawl) {
    if (validated.crawl.concurrency !== undefined) {
      const c = validated.crawl.concurrency;
      if (typeof c !== 'number' || c < 1 || c > 20) {
        warnings.push(`Invalid crawl.concurrency: ${c} (must be 1-20)`);
        delete validated.crawl.concurrency;
      }
    }
    if (validated.crawl.timeout !== undefined) {
      const t = validated.crawl.timeout;
      if (typeof t !== 'number' || t < 1000 || t > 300000) {
        warnings.push(`Invalid crawl.timeout: ${t} (must be 1000-300000ms)`);
        delete validated.crawl.timeout;
      }
    }
    if (validated.crawl.batchSize !== undefined) {
      const b = validated.crawl.batchSize;
      if (typeof b !== 'number' || b < 10 || b > 1000) {
        warnings.push(`Invalid crawl.batchSize: ${b} (must be 10-1000)`);
        delete validated.crawl.batchSize;
      }
    }
    if (validated.crawl.maxDiscoveredUrls !== undefined) {
      const m = validated.crawl.maxDiscoveredUrls;
      if (typeof m !== 'number' || m < 1000 || m > 1000000) {
        warnings.push(`Invalid crawl.maxDiscoveredUrls: ${m} (must be 1000-1000000)`);
        delete validated.crawl.maxDiscoveredUrls;
      }
    }
  }

  // Validate excludeUrls patterns (limit complexity to prevent ReDoS)
  if (validated.excludeUrls && Array.isArray(validated.excludeUrls)) {
    validated.excludeUrls = validated.excludeUrls.filter((pattern: unknown, index: number) => {
      if (typeof pattern !== 'string') {
        warnings.push(`Invalid excludeUrls[${index}]: must be a string`);
        return false;
      }
      if (pattern.length > 500) {
        warnings.push(`excludeUrls[${index}] too long (max 500 chars)`);
        return false;
      }
      // Check for too many wildcards using simple string counting (safe from ReDoS)
      const wildcardCount = (pattern.match(/\*/g) ?? []).length;
      if (wildcardCount > 2) {
        warnings.push(`excludeUrls[${index}] has too many wildcards (${wildcardCount}, max 2)`);
        return false;
      }
      return true;
    });
  }

  // Validate queryParams
  if (validated.queryParams) {
    const validModes = ['strip_all', 'strip_tracking', 'keep_all', 'whitelist'];
    if (validated.queryParams.mode && !validModes.includes(validated.queryParams.mode)) {
      warnings.push(
        `Invalid queryParams.mode: "${validated.queryParams.mode}" (must be one of: ${validModes.join(', ')})`,
      );
      delete validated.queryParams.mode;
    }
    // Validate whitelist is an array of strings
    if (validated.queryParams.whitelist && !Array.isArray(validated.queryParams.whitelist)) {
      warnings.push(`Invalid queryParams.whitelist: must be an array`);
      delete validated.queryParams.whitelist;
    }
    // Validate blacklist is an array of strings
    if (validated.queryParams.blacklist && !Array.isArray(validated.queryParams.blacklist)) {
      warnings.push(`Invalid queryParams.blacklist: must be an array`);
      delete validated.queryParams.blacklist;
    }
  }

  // Validate analysis settings
  if (validated.analysis) {
    if (validated.analysis.similarityThreshold !== undefined) {
      const s = validated.analysis.similarityThreshold;
      if (typeof s !== 'number' || s < 0 || s > 1) {
        warnings.push(`Invalid analysis.similarityThreshold: ${s} (must be 0-1)`);
        delete validated.analysis.similarityThreshold;
      }
    }
    if (validated.analysis.jsUnusedThreshold !== undefined) {
      const j = validated.analysis.jsUnusedThreshold;
      if (typeof j !== 'number' || j < 0 || j > 100) {
        warnings.push(`Invalid analysis.jsUnusedThreshold: ${j} (must be 0-100)`);
        delete validated.analysis.jsUnusedThreshold;
      }
    }
    if (validated.analysis.cssUnusedThreshold !== undefined) {
      const c = validated.analysis.cssUnusedThreshold;
      if (typeof c !== 'number' || c < 0 || c > 100) {
        warnings.push(`Invalid analysis.cssUnusedThreshold: ${c} (must be 0-100)`);
        delete validated.analysis.cssUnusedThreshold;
      }
    }
    if (validated.analysis.maxOutboundChecks !== undefined) {
      const m = validated.analysis.maxOutboundChecks;
      if (typeof m !== 'number' || m < 0 || m > 100) {
        warnings.push(`Invalid analysis.maxOutboundChecks: ${m} (must be 0-100)`);
        delete validated.analysis.maxOutboundChecks;
      }
    }
    if (validated.analysis.outboundTimeout !== undefined) {
      const t = validated.analysis.outboundTimeout;
      if (typeof t !== 'number' || t < 1000 || t > 30000) {
        warnings.push(`Invalid analysis.outboundTimeout: ${t} (must be 1000-30000)`);
        delete validated.analysis.outboundTimeout;
      }
    }
  }

  // Validate report settings
  if (validated.report) {
    if (validated.report.maxQuickWins !== undefined) {
      const m = validated.report.maxQuickWins;
      if (typeof m !== 'number' || m < 1 || m > 50) {
        warnings.push(`Invalid report.maxQuickWins: ${m} (must be 1-50)`);
        delete validated.report.maxQuickWins;
      }
    }
    if (validated.report.showQuickWins !== undefined && typeof validated.report.showQuickWins !== 'boolean') {
      warnings.push(`Invalid report.showQuickWins: must be a boolean`);
      delete validated.report.showQuickWins;
    }
  }

  // Print warnings
  if (warnings.length > 0) {
    console.warn('⚠️  Config validation warnings:');
    warnings.forEach((w) => console.warn(`   - ${w}`));
  }

  return validated;
}

/**
 * Validate merged config to ensure consistency after deepMerge
 * Checks for type errors and constraint violations that may have occurred during merge
 * @param {Object} config - Merged configuration
 * @returns {Object} Validated config
 */
function validateMergedConfig(config: ConfigRecord) {
  const validated = { ...config };
  const errors: string[] = [];

  // Ensure required sections exist with correct types
  if (!validated.thresholds || typeof validated.thresholds !== 'object') {
    errors.push('thresholds must be an object');
    validated.thresholds = { ...DEFAULT_CONFIG.thresholds };
  }

  if (!validated.crawl || typeof validated.crawl !== 'object') {
    errors.push('crawl must be an object');
    validated.crawl = { ...DEFAULT_CONFIG.crawl };
  }

  if (!validated.queryParams || typeof validated.queryParams !== 'object') {
    errors.push('queryParams must be an object');
    validated.queryParams = { ...DEFAULT_CONFIG.queryParams };
  }

  // Ensure critical numeric thresholds are valid after merge
  const criticalThresholds = ['TTFB', 'LCP', 'CLS', 'FCP'];
  for (const key of criticalThresholds) {
    const val = validated.thresholds[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      errors.push(`Invalid merged threshold ${key}: ${val}`);
      validated.thresholds[key] = (DEFAULT_CONFIG.thresholds as Record<string, number>)[key];
    }
  }

  // Ensure concurrency is within bounds
  if (
    typeof validated.crawl.concurrency !== 'number' ||
    validated.crawl.concurrency < 1 ||
    validated.crawl.concurrency > 20
  ) {
    validated.crawl.concurrency = DEFAULT_CONFIG.crawl.concurrency;
  }

  // Ensure arrays are actually arrays
  if (!Array.isArray(validated.excludeUrls)) {
    validated.excludeUrls = [];
  }
  if (!Array.isArray(validated.includeUrls)) {
    validated.includeUrls = [];
  }

  if (errors.length > 0) {
    console.warn('⚠️  Config merge validation issues (using defaults):');
    errors.forEach((e) => console.warn(`   - ${e}`));
  }

  return validated;
}

/**
 * Deep merge two objects
 * For arrays: concatenates unique values (useful for excludeUrls, blacklist)
 * For objects: recursively merges
 * For primitives: source overwrites target
 * @param {Object} target - Target object (defaults)
 * @param {Object} source - Source object (user config, overwrites target)
 * @param {Object} options - Merge options
 * @param {Array<string>} options.replaceArrays - Array keys to replace instead of merge
 * @returns {Object} Merged object
 */
function deepMerge(target: ConfigRecord, source: ConfigRecord, options: { replaceArrays?: string[] } = {}) {
  const result: ConfigRecord = { ...target };
  const replaceArrays = options.replaceArrays ?? ['whitelist']; // These arrays replace, not merge

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (sourceVal === null || sourceVal === undefined) {
      // Skip null/undefined values from source
      continue;
    }

    if (Array.isArray(sourceVal)) {
      if (replaceArrays.includes(key)) {
        // Replace array entirely (e.g., whitelist should be user's choice)
        result[key] = [...sourceVal];
      } else if (Array.isArray(targetVal)) {
        // Merge arrays with unique values (e.g., excludeUrls, blacklist)
        const merged = [...targetVal];
        for (const item of sourceVal) {
          if (!merged.includes(item)) {
            merged.push(item);
          }
        }
        result[key] = merged;
      } else {
        result[key] = [...sourceVal];
      }
    } else if (sourceVal && typeof sourceVal === 'object') {
      result[key] = deepMerge(
        (targetVal && typeof targetVal === 'object' ? targetVal : {}) as ConfigRecord,
        sourceVal as ConfigRecord,
        options,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * Apply config thresholds to constants
 * @param {Object} config - Configuration object
 * @param {Object} constants - Constants module to update
 */
function applyConfigToConstants(config: ConfigRecord, constants: Record<string, unknown>) {
  if (config.thresholds) {
    const thresholds = constants['THRESHOLDS'];
    if (thresholds && typeof thresholds === 'object') {
      for (const [key, value] of Object.entries(config.thresholds)) {
        if (key in thresholds) {
          (thresholds as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
}

/**
 * Check if URL should be excluded
 * @param {string} url - URL to check
 * @param {Object} config - Configuration object
 * @returns {boolean} True if URL should be excluded
 */
function shouldExcludeUrl(url: string, config: ConfigRecord) {
  if (!config.excludeUrls || config.excludeUrls.length === 0) {
    return false;
  }

  for (const pattern of config.excludeUrls) {
    if (matchesPattern(url, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if URL matches a pattern (supports * wildcard)
 * Uses safe string-based matching to avoid ReDoS vulnerabilities
 * @param {string} url - URL to check
 * @param {string} pattern - Pattern with optional * wildcards
 * @returns {boolean} True if URL matches pattern
 */
function matchesPattern(url: string, pattern: string) {
  // Fast path: exact match
  if (pattern === url) {
    return true;
  }

  // Limit URL length for safety
  if (url.length > 2000) {
    return false;
  }

  // Fast path: no wildcards - simple substring match
  if (!pattern.includes('*')) {
    return url.includes(pattern);
  }

  // Use safe string-based glob matching instead of regex
  // Split pattern by * and match segments in order
  const segments = pattern.split('*');

  // Empty pattern or just "*" matches everything
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    return true;
  }

  let searchPos = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    // Empty segment means * at start, end, or consecutive *
    if (segment === '') {
      continue;
    }

    // First segment must match at start if pattern doesn't start with *
    if (i === 0 && !pattern.startsWith('*')) {
      if (!url.startsWith(segment)) {
        return false;
      }
      searchPos = segment.length;
      continue;
    }

    // Last segment must match at end if pattern doesn't end with *
    if (i === segments.length - 1 && !pattern.endsWith('*')) {
      if (!url.endsWith(segment)) {
        return false;
      }
      // Also check that we haven't passed it
      const expectedPos = url.length - segment.length;
      if (expectedPos < searchPos) {
        return false;
      }
      continue;
    }

    // Middle segments: find next occurrence
    const foundPos = url.indexOf(segment, searchPos);
    if (foundPos === -1) {
      return false;
    }
    searchPos = foundPos + segment.length;
  }

  return true;
}

/**
 * Generate a sample config file
 * @returns {string} Sample config JSON
 */
function generateSampleConfig() {
  return JSON.stringify(
    {
      thresholds: {
        TTFB: 800,
        LCP: 2500,
        CLS: 0.1,
        TITLE_MIN: 30,
        TITLE_MAX: 60,
        DESCRIPTION_MIN: 120,
        DESCRIPTION_MAX: 160,
      },
      crawl: {
        concurrency: 5,
        timeout: 30000,
        batchSize: 100, // Pages per batch file (10-1000)
        maxDiscoveredUrls: 100000, // Max URLs to discover via crawling (1000-1000000)
      },
      queryParams: {
        mode: 'strip_tracking', // 'strip_all' | 'strip_tracking' | 'keep_all' | 'whitelist'
        whitelist: ['page', 'id'], // Params to keep when mode is 'whitelist'
        blacklist: [], // Additional params to strip
      },
      analysis: {
        similarityThreshold: 0.6, // Near-duplicate content detection threshold (0-1)
        jsUnusedThreshold: 50, // Flag pages with more than N% unused JS
        cssUnusedThreshold: 60, // Flag pages with more than N% unused CSS
        maxOutboundChecks: 20, // Max external links to verify per page
        outboundTimeout: 5000, // Timeout for external link checks (ms)
      },
      excludeUrls: ['/admin/*', '/staging/*', '*.pdf'],
      report: {
        showQuickWins: true,
        maxQuickWins: 10,
      },
      apiKeys: {
        crux: null, // Google API key for CrUX real-user data (https://console.cloud.google.com/apis/credentials)
      },
    },
    null,
    2,
  );
}

/**
 * Pretty-print config summary for --verbose mode
 * @param {Object} config - Merged config
 * @returns {string} Human-readable config summary
 */
function getConfigSummary(config: ConfigRecord) {
  const lines: string[] = [];
  lines.push('Active Configuration:');

  // Thresholds
  const th = config.thresholds ?? {};
  lines.push(`  Thresholds: TTFB≤${th.TTFB}ms LCP≤${th.LCP}ms CLS≤${th.CLS} Title:${th.TITLE_MIN}-${th.TITLE_MAX}ch`);

  // Crawl
  const cr = config.crawl ?? {};
  lines.push(
    `  Crawl: concurrency=${cr.concurrency} timeout=${cr.timeout}ms retries=${cr.retryAttempts} batch=${cr.batchSize}`,
  );

  // Analysis
  const an = config.analysis ?? {};
  if (an.similarityThreshold !== undefined || an.jsUnusedThreshold !== undefined) {
    lines.push(
      `  Analysis: similarity=${an.similarityThreshold ?? 0.6} jsUnused=${an.jsUnusedThreshold ?? 50}% outbound=${an.maxOutboundChecks ?? 20}`,
    );
  }

  // Query params
  const qp = config.queryParams ?? {};
  lines.push(`  Query params: mode=${qp.mode}`);

  // Excludes
  if (config.excludeUrls && config.excludeUrls.length > 0) {
    lines.push(
      `  Exclude: ${config.excludeUrls.slice(0, 3).join(', ')}${config.excludeUrls.length > 3 ? ` (+${config.excludeUrls.length - 3} more)` : ''}`,
    );
  }

  return lines.join('\n');
}

/**
 * Validate config file and return structured result (for --validate-config)
 * @param {string} configPath - Path to config file
 * @returns {Object} { valid: boolean, errors: string[], warnings: string[], config: Object }
 */
function validateConfigFile(configPath: string | null) {
  const result: { valid: boolean; errors: string[]; warnings: string[]; config: Record<string, unknown> | null } = {
    valid: true,
    errors: [],
    warnings: [],
    config: null,
  };

  if (!configPath) {
    // Find config automatically
    for (const fileName of CONFIG_FILE_NAMES) {
      const filePath = path.join(process.cwd(), fileName);
      if (fs.existsSync(filePath)) {
        configPath = filePath;
        break;
      }
    }
    if (!configPath) {
      result.valid = false;
      result.errors.push('No config file found. Create one with --init-config');
      return result;
    }
  }

  if (!fs.existsSync(configPath)) {
    result.valid = false;
    result.errors.push(`Config file not found: ${configPath}`);
    return result;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Check for unknown keys
    const knownKeys = new Set(Object.keys(CONFIG_SCHEMA));
    for (const key of Object.keys(parsed)) {
      if (!knownKeys.has(key)) {
        result.warnings.push(`Unknown key "${key}" will be ignored`);
      }
    }

    // Check threshold values
    if (parsed.thresholds) {
      for (const [key, value] of Object.entries(parsed.thresholds)) {
        if (typeof value !== 'number' || value < 0) {
          result.errors.push(`Invalid threshold ${key}: ${value} (must be positive number)`);
          result.valid = false;
        }
      }
    }

    // Check crawl settings
    if (parsed.crawl) {
      if (parsed.crawl.concurrency && (parsed.crawl.concurrency < 1 || parsed.crawl.concurrency > 20)) {
        result.errors.push(`crawl.concurrency ${parsed.crawl.concurrency} out of range (1-20)`);
        result.valid = false;
      }
    }

    result.config = parsed;
  } catch (e: unknown) {
    result.valid = false;
    result.errors.push(`JSON parse error: ${(e as Error).message}`);
  }

  return result;
}

export {
  loadConfig,
  applyConfigToConstants,
  shouldExcludeUrl,
  generateSampleConfig,
  getConfigSummary,
  validateConfigFile,
  DEFAULT_CONFIG,
};
