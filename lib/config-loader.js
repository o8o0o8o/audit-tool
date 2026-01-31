/**
 * Config Loader
 * Loads and merges configuration from files and CLI arguments
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE_NAMES = [
  '.seoauditrc',
  '.seoauditrc.json',
  'seoaudit.config.json',
];

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  // Performance thresholds
  thresholds: {
    TTFB: 800,
    LCP: 2500,
    CLS: 0.1,
    FCP: 1800,
    INP: 200,
    PAGE_SIZE: 6 * 1024 * 1024, // 6MB
    REQUESTS: 20,
    TITLE_MIN: 30,
    TITLE_MAX: 60,
    DESCRIPTION_MIN: 120,
    DESCRIPTION_MAX: 160,
    MIN_CONTENT_WORDS: 300,
    RECOMMENDED_CONTENT_WORDS: 600,
  },

  // Crawl settings
  crawl: {
    concurrency: 5,
    timeout: 30000,
    retryAttempts: 3,
    userAgent: null, // Use default Playwright UA
  },

  // URL filtering
  excludeUrls: [],
  includeUrls: [], // Empty = include all

  // Report settings
  report: {
    showQuickWins: true,
    maxQuickWins: 10,
    showPerformanceCharts: true,
  },
};

/**
 * Load configuration from file
 * @param {string} configPath - Optional explicit config path
 * @returns {Object} Merged configuration
 */
function loadConfig(configPath = null) {
  let userConfig = {};

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
  return deepMerge(DEFAULT_CONFIG, userConfig);
}

/**
 * Load and parse a config file
 * @param {string} filePath - Path to config file
 * @returns {Object} Parsed config
 */
function loadConfigFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Error parsing config file ${filePath}: ${error.message}`);
    return {};
  }
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object (overwrites target)
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Apply config thresholds to constants
 * @param {Object} config - Configuration object
 * @param {Object} constants - Constants module to update
 */
function applyConfigToConstants(config, constants) {
  if (config.thresholds) {
    for (const [key, value] of Object.entries(config.thresholds)) {
      if (constants.THRESHOLDS && key in constants.THRESHOLDS) {
        constants.THRESHOLDS[key] = value;
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
function shouldExcludeUrl(url, config) {
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
 * @param {string} url - URL to check
 * @param {string} pattern - Pattern with optional * wildcards
 * @returns {boolean} True if URL matches pattern
 */
function matchesPattern(url, pattern) {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/\*/g, '.*'); // Convert * to .*

  const regex = new RegExp(regexPattern);
  return regex.test(url);
}

/**
 * Generate a sample config file
 * @returns {string} Sample config JSON
 */
function generateSampleConfig() {
  return JSON.stringify({
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
    },
    excludeUrls: [
      '/admin/*',
      '/staging/*',
      '*.pdf',
    ],
    report: {
      showQuickWins: true,
      maxQuickWins: 10,
    },
  }, null, 2);
}

module.exports = {
  loadConfig,
  applyConfigToConstants,
  shouldExcludeUrl,
  generateSampleConfig,
  DEFAULT_CONFIG,
};
