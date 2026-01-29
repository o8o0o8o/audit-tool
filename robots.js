const { parse } = require("node-html-parser");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { generateHTML } = require("./generateHTML");

// Import modularized components
const { parseArgs } = require("./lib/args-parser");
const { KNOWN_ERRORS, SEVERITY, THRESHOLDS, NETWORK_CONDITIONS, CPU_CONDITIONS, META_TAGS } = require("./lib/constants");
const { stripHashFragment, validateUrl, createSafeFilename, analyzeUrlStructure, formatElapsedTime } = require("./lib/utils");
const { FileManager } = require("./lib/storage/file-manager");
const { ScoreCalculator } = require("./lib/scoring/score-calculator");
const { VitalsCollector } = require("./lib/crawler/vitals-collector");
const { RobotsParser } = require("./lib/parsers/robots-parser");
const { SitemapParser } = require("./lib/parsers/sitemap-parser");

// SEO analyzers
const { HeadingAnalyzer } = require('./lib/analyzers/seo/heading-analyzer');
const { ImageAnalyzer } = require('./lib/analyzers/seo/image-analyzer');
const { StructuredDataAnalyzer } = require('./lib/analyzers/seo/structured-data-analyzer');
const { IndexabilityAnalyzer } = require('./lib/analyzers/seo/indexability-analyzer');
const { CrawlabilityAnalyzer } = require('./lib/analyzers/seo/crawlability-analyzer');

// Performance analyzers
const { ImageOptimizationAnalyzer } = require('./lib/analyzers/performance/image-optimization-analyzer');
const { ResourceOptimizationAnalyzer } = require('./lib/analyzers/performance/resource-optimization-analyzer');
const { CachingAnalyzer } = require('./lib/analyzers/performance/caching-analyzer');

// Content analyzers
const { LinkQualityAnalyzer } = require('./lib/analyzers/content/link-quality-analyzer');
const { ContentQualityAnalyzer } = require('./lib/analyzers/content/content-quality-analyzer');

// Accessibility analyzers
const { AccessibilityAnalyzer } = require('./lib/analyzers/accessibility/accessibility-analyzer');
const { MobileFriendlyAnalyzer } = require('./lib/analyzers/accessibility/mobile-friendly-analyzer');

// International, Social, Analytics, Security
const { InternationalSEOAnalyzer } = require('./lib/analyzers/international/international-seo-analyzer');
const { SocialMediaAnalyzer } = require('./lib/analyzers/social/social-media-analyzer');
const { AnalyticsTrackingAnalyzer } = require('./lib/analyzers/analytics/analytics-tracking-analyzer');
const { SecurityAnalyzer } = require('./lib/analyzers/security/security-analyzer');

// Site-wide validators
const { DuplicateChecker } = require('./lib/analyzers/site-wide/duplicate-checker');
const { StructuredDataValidator } = require('./lib/analyzers/site-wide/structured-data-validator');
const { LinkStructureAnalyzer } = require('./lib/analyzers/site-wide/link-structure-analyzer');
const { SocialMediaValidator } = require('./lib/analyzers/site-wide/social-media-validator');
const { AnalyticsValidator } = require('./lib/analyzers/site-wide/analytics-validator');
const { IndexabilityValidator } = require('./lib/analyzers/site-wide/indexability-validator');
const { InternationalSEOValidator } = require('./lib/analyzers/site-wide/international-seo-validator');

class SEOData {
  #results;
  #proceed;
  #perf;
  #saveHtml;
  #concurrency;
  #incomingLinksTracking; // Map to track unique source->target links during processing

  constructor(origin, proceed = false, perf = false, saveHtml = false, concurrency = 5) {
    // Validate URL first
    const validatedUrl = validateUrl(origin);

    // Store flags as booleans
    this.#proceed = proceed;
    this.#perf = perf;
    this.#saveHtml = saveHtml;
    this.#concurrency = concurrency;

    // Initialize incoming links tracking (Map<target, Set<source>>)
    this.#incomingLinksTracking = new Map();

    this.origin = validatedUrl.replace(/\s/g, "").replace(/\/$/, "");
    this.domainName = this.origin.replace(/^https?:\/\//, "");

    // Initialize FileManager
    // If proceeding, find and use the latest run's timestamp
    let timestamp = null;
    if (proceed) {
      const latestRun = FileManager.findLatestRun(this.domainName);
      if (latestRun) {
        // Extract timestamp from path
        timestamp = path.basename(latestRun);
        console.log(`📂 Resuming from previous run: ${timestamp}`);
      }
    }

    this.fileManager = new FileManager(this.domainName, 'audit-results', timestamp);
    this.resultsDir = this.fileManager.resultsDir;
    this.file = this.fileManager.getMainFilePath();

    this.#results = {
      robots: { sitemaps: [], "user-agent": {} },
      sitemaps: { urls: {}, total: 0 },
      isMultiLang: false,
      pageData: {
        pages: {},
        processedPages: new Set(),
        totalWithoutError: 0,
        totalWithError: 0,
        byError: {},
        attempts: {},
        incomingLinks: {}, // Track incoming links count: { targetUrl: count }
      },
      analysis: {
        overall: new Set(),
        details: {},
        bySeverity: {
          critical: [],
          high: [],
          medium: [],
          low: [],
        },
        summary: {
          totalIssues: 0,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
        },
      },
      timing: {
        startTime: null,
        endTime: null,
        elapsedTime: null, // in milliseconds
        elapsedTimeFormatted: null, // human readable format
      },
    };

    // Use imported network and CPU conditions from constants
    this.networkConditions = NETWORK_CONDITIONS;
    this.cpuConditions = CPU_CONDITIONS;
  }

  // Getter for results data (used by history manager and other external consumers)
  get data() {
    return this.#results;
  }

  async #analyzeImageOptimization(chromePage, requests) {
    const imageAnalysis = {
      totalImages: 0,
      totalImageSize: 0,
      oversizedImages: [],
      modernFormats: 0,
      legacyFormats: 0,
      withLazyLoading: 0,
      withoutLazyLoading: 0,
      withoutAlt: 0,
      issues: [],
    };

    // Get all images with their properties
    const imageElements = await chromePage.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.map(img => ({
        src: img.src || img.getAttribute('src'),
        loading: img.loading, // 'lazy', 'eager', or undefined
        width: img.width,
        height: img.height,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        alt: img.alt,
        displayWidth: img.getBoundingClientRect().width,
        displayHeight: img.getBoundingClientRect().height,
      }));
    });

    imageAnalysis.totalImages = imageElements.length;

    for (const img of imageElements) {
      // Check alt attribute
      if (!img.alt || img.alt.trim() === '') {
        imageAnalysis.withoutAlt++;
      }

      // Check lazy loading
      if (img.loading === 'lazy') {
        imageAnalysis.withLazyLoading++;
      } else {
        imageAnalysis.withoutLazyLoading++;
      }

      // Analyze image from requests
      if (img.src && requests[img.src]) {
        const imgRequest = requests[img.src];
        const size = imgRequest.size || 0;

        imageAnalysis.totalImageSize += size;

        // Check image format
        const url = img.src.toLowerCase();
        if (url.includes('.webp') || url.includes('.avif')) {
          imageAnalysis.modernFormats++;
        } else if (url.includes('.jpg') || url.includes('.jpeg') || url.includes('.png') || url.includes('.gif')) {
          imageAnalysis.legacyFormats++;
        }

        // Check image size
        if (size > THRESHOLDS.IMAGE_SIZE_MAX) {
          imageAnalysis.oversizedImages.push({
            src: img.src,
            size: size,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            displayWidth: Math.round(img.displayWidth),
            displayHeight: Math.round(img.displayHeight),
          });
        }

        // Check if image is scaled down significantly (wasting bandwidth)
        if (img.naturalWidth && img.displayWidth) {
          const widthRatio = img.naturalWidth / img.displayWidth;
          const heightRatio = img.naturalHeight / img.displayHeight;

          if (widthRatio > 2 || heightRatio > 2) {
            imageAnalysis.issues.push({
              severity: SEVERITY.MEDIUM,
              message: `Image ${img.src.substring(0, 50)}... is oversized (${img.naturalWidth}x${img.naturalHeight} displayed as ${Math.round(img.displayWidth)}x${Math.round(img.displayHeight)})`,
            });
          }
        }
      }
    }

    // Generate summary issues
    if (imageAnalysis.totalImages >= THRESHOLDS.LAZY_LOAD_THRESHOLD && imageAnalysis.withLazyLoading === 0) {
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `Page has ${imageAnalysis.totalImages} images but none use lazy loading`,
      });
    }

    if (imageAnalysis.oversizedImages.length > 0) {
      imageAnalysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `${imageAnalysis.oversizedImages.length} image(s) exceed ${Math.round(THRESHOLDS.IMAGE_SIZE_MAX / 1000)}KB`,
      });
    }

    if (imageAnalysis.totalImageSize > THRESHOLDS.TOTAL_IMAGE_SIZE_MAX) {
      imageAnalysis.issues.push({
        severity: SEVERITY.HIGH,
        message: `Total image size (${Math.round(imageAnalysis.totalImageSize / 1000)}KB) exceeds recommended ${Math.round(THRESHOLDS.TOTAL_IMAGE_SIZE_MAX / 1000)}KB`,
      });
    }

    if (imageAnalysis.legacyFormats > 0 && imageAnalysis.modernFormats === 0) {
      imageAnalysis.issues.push({
        severity: SEVERITY.MEDIUM,
        message: `All ${imageAnalysis.legacyFormats} images use legacy formats (JPG/PNG). Consider WebP/AVIF for better compression`,
      });
    }

    return imageAnalysis;
  }

  async #analyzeResourceOptimization(chromePage, requests) {
    const resourceAnalysis = {
      compression: {
        gzipCompressed: 0,
        brotliCompressed: 0,
        uncompressed: 0,
        totalSize: 0,
        compressedSize: 0,
        issues: [],
      },
      minification: {
        minifiedJS: 0,
        unminifiedJS: 0,
        minifiedCSS: 0,
        unminifiedCSS: 0,
        issues: [],
      },
      renderBlocking: {
        blockingScripts: 0,
        blockingStyles: 0,
        totalBlocking: 0,
        issues: [],
      },
      protocol: {
        http1: 0,
        http2: 0,
        http3: 0,
      },
    };

    // Analyze all requests
    for (const [url, reqData] of Object.entries(requests)) {
      const headers = reqData.headers || {};
      const size = reqData.size || 0;
      const resourceType = reqData.resourceType;

      // Check compression
      const contentEncoding = headers['content-encoding'] || '';
      if (contentEncoding.includes('br')) {
        resourceAnalysis.compression.brotliCompressed++;
        resourceAnalysis.compression.compressedSize += size;
      } else if (contentEncoding.includes('gzip')) {
        resourceAnalysis.compression.gzipCompressed++;
        resourceAnalysis.compression.compressedSize += size;
      } else if (resourceType === 'script' || resourceType === 'stylesheet' || resourceType === 'document') {
        resourceAnalysis.compression.uncompressed++;
        if (size > 5000) { // Only flag significant uncompressed resources
          resourceAnalysis.compression.issues.push({
            severity: SEVERITY.MEDIUM,
            url: url,
            size: size,
          });
        }
      }

      resourceAnalysis.compression.totalSize += size;

      // Check minification for JS/CSS
      if (resourceType === 'script' && size > THRESHOLDS.UNMINIFIED_SIZE_THRESHOLD) {
        const urlLower = url.toLowerCase();
        if (urlLower.includes('.min.js') || urlLower.includes('-min.js')) {
          resourceAnalysis.minification.minifiedJS++;
        } else if (!urlLower.includes('node_modules')) {
          resourceAnalysis.minification.unminifiedJS++;
          resourceAnalysis.minification.issues.push({
            severity: SEVERITY.LOW,
            url: url,
            type: 'JavaScript',
            size: size,
          });
        }
      }

      if (resourceType === 'stylesheet' && size > THRESHOLDS.UNMINIFIED_SIZE_THRESHOLD) {
        const urlLower = url.toLowerCase();
        if (urlLower.includes('.min.css') || urlLower.includes('-min.css')) {
          resourceAnalysis.minification.minifiedCSS++;
        } else {
          resourceAnalysis.minification.unminifiedCSS++;
          resourceAnalysis.minification.issues.push({
            severity: SEVERITY.LOW,
            url: url,
            type: 'CSS',
            size: size,
          });
        }
      }

      // Detect HTTP protocol version
      const protocol = headers[':protocol'] || headers['protocol'] || '';
      if (protocol.includes('h3') || protocol.includes('http/3')) {
        resourceAnalysis.protocol.http3++;
      } else if (protocol.includes('h2') || protocol.includes('http/2')) {
        resourceAnalysis.protocol.http2++;
      } else {
        resourceAnalysis.protocol.http1++;
      }
    }

    // Check for render-blocking resources
    const renderBlockingInfo = await chromePage.evaluate(() => {
      const blockingScripts = Array.from(document.querySelectorAll('script:not([async]):not([defer]):not([type="module"])')).filter(script => {
        const src = script.src || '';
        return src && !src.includes('data:');
      });

      const blockingStyles = Array.from(document.querySelectorAll('link[rel="stylesheet"]:not([media="print"])')).filter(link => {
        return !link.hasAttribute('disabled');
      });

      return {
        blockingScripts: blockingScripts.length,
        blockingStyles: blockingStyles.length,
      };
    });

    resourceAnalysis.renderBlocking.blockingScripts = renderBlockingInfo.blockingScripts;
    resourceAnalysis.renderBlocking.blockingStyles = renderBlockingInfo.blockingStyles;
    resourceAnalysis.renderBlocking.totalBlocking = renderBlockingInfo.blockingScripts + renderBlockingInfo.blockingStyles;

    if (resourceAnalysis.renderBlocking.totalBlocking > THRESHOLDS.RENDER_BLOCKING_MAX) {
      resourceAnalysis.renderBlocking.issues.push({
        severity: SEVERITY.HIGH,
        message: `${resourceAnalysis.renderBlocking.totalBlocking} render-blocking resources (${renderBlockingInfo.blockingScripts} scripts, ${renderBlockingInfo.blockingStyles} styles)`,
      });
    }

    return resourceAnalysis;
  }

  async #analyzeAccessibility(chromePage) {
    const a11yAnalysis = await chromePage.evaluate((thresholds) => {
      const analysis = {
        aria: {
          valid: 0,
          invalid: 0,
          missingLabels: 0,
          issues: [],
        },
        forms: {
          totalForms: 0,
          inputsWithLabels: 0,
          inputsWithoutLabels: 0,
          missingFieldsets: 0,
          issues: [],
        },
        keyboard: {
          elementsWithTabindex: 0,
          positiveTabindex: 0,
          elementsWithoutFocus: 0,
          issues: [],
        },
        semantic: {
          hasMain: false,
          hasNav: false,
          hasHeader: false,
          hasFooter: false,
          hasSkipLink: false,
          landmarkIssues: [],
        },
        interactive: {
          linksWithoutText: 0,
          buttonsWithoutText: 0,
          smallTouchTargets: 0,
          issues: [],
        },
        images: {
          totalImages: 0,
          withAlt: 0,
          withoutAlt: 0,
          decorativeImages: 0,
          issues: [],
        },
        language: {
          hasLangAttribute: false,
          langValue: null,
        },
        a11yScore: 100,
      };

      // Valid ARIA roles
      const validAriaRoles = [
        'alert', 'alertdialog', 'application', 'article', 'banner', 'button',
        'cell', 'checkbox', 'columnheader', 'combobox', 'complementary',
        'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed',
        'figure', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link',
        'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu',
        'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation',
        'none', 'note', 'option', 'presentation', 'progressbar', 'radio',
        'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar',
        'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
        'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
        'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'
      ];

      // Check language attribute
      const htmlEl = document.documentElement;
      analysis.language.hasLangAttribute = htmlEl.hasAttribute('lang');
      analysis.language.langValue = htmlEl.getAttribute('lang');

      if (!analysis.language.hasLangAttribute) {
        analysis.aria.issues.push('Missing lang attribute on <html> tag');
        analysis.a11yScore -= 5;
      }

      // Check ARIA attributes
      const elementsWithRole = document.querySelectorAll('[role]');
      for (const el of elementsWithRole) {
        const role = el.getAttribute('role');
        if (validAriaRoles.includes(role)) {
          analysis.aria.valid++;
        } else {
          analysis.aria.invalid++;
          analysis.aria.issues.push(`Invalid ARIA role: "${role}"`);
          analysis.a11yScore -= 2;
        }
      }

      // Check for missing aria-label or aria-labelledby on interactive elements with roles
      const interactiveRoles = ['button', 'link', 'menuitem', 'tab', 'option'];
      const roleElements = document.querySelectorAll('[role]');
      for (const el of roleElements) {
        const role = el.getAttribute('role');
        if (interactiveRoles.includes(role)) {
          const hasLabel = el.hasAttribute('aria-label') ||
                          el.hasAttribute('aria-labelledby') ||
                          el.textContent.trim() !== '';
          if (!hasLabel) {
            analysis.aria.missingLabels++;
            analysis.aria.issues.push(`Element with role="${role}" missing accessible label`);
            analysis.a11yScore -= 3;
          }
        }
      }

      // Form accessibility
      const forms = document.querySelectorAll('form');
      analysis.forms.totalForms = forms.length;

      for (const form of forms) {
        // Check for fieldset in forms with multiple inputs
        const inputs = form.querySelectorAll('input, select, textarea');
        if (inputs.length > 3 && !form.querySelector('fieldset')) {
          analysis.forms.missingFieldsets++;
          analysis.forms.issues.push('Form with multiple inputs missing <fieldset>');
          analysis.a11yScore -= 2;
        }
      }

      // Check all form inputs for labels
      const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      for (const input of inputs) {
        const id = input.id;
        const hasLabel = id && document.querySelector(`label[for="${id}"]`);
        const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
        const hasTitle = input.hasAttribute('title');

        if (hasLabel || hasAriaLabel || hasTitle) {
          analysis.forms.inputsWithLabels++;
        } else {
          analysis.forms.inputsWithoutLabels++;
          analysis.forms.issues.push(`Input without associated label: type="${input.type || 'text'}"`);
          analysis.a11yScore -= 3;
        }
      }

      // Keyboard navigation
      const tabindexElements = document.querySelectorAll('[tabindex]');
      analysis.keyboard.elementsWithTabindex = tabindexElements.length;

      for (const el of tabindexElements) {
        const tabindex = parseInt(el.getAttribute('tabindex'));
        if (tabindex > 0) {
          analysis.keyboard.positiveTabindex++;
          analysis.keyboard.issues.push(`Element has positive tabindex (${tabindex}), should be 0 or -1`);
          analysis.a11yScore -= 2;
        }
      }

      // Check interactive elements for focus indicators
      const interactiveElements = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]');
      for (const el of interactiveElements) {
        const styles = window.getComputedStyle(el, ':focus');
        const outlineWidth = styles.outlineWidth;
        const outlineStyle = styles.outlineStyle;

        if (outlineWidth === '0px' || outlineStyle === 'none') {
          const hasCustomFocus = styles.boxShadow !== 'none' || styles.border !== el.style.border;
          if (!hasCustomFocus) {
            analysis.keyboard.elementsWithoutFocus++;
          }
        }
      }

      if (analysis.keyboard.elementsWithoutFocus > 5) {
        analysis.keyboard.issues.push(`${analysis.keyboard.elementsWithoutFocus} interactive elements missing focus indicators`);
        analysis.a11yScore -= 5;
      }

      // Semantic HTML structure
      analysis.semantic.hasMain = document.querySelector('main, [role="main"]') !== null;
      analysis.semantic.hasNav = document.querySelector('nav, [role="navigation"]') !== null;
      analysis.semantic.hasHeader = document.querySelector('header, [role="banner"]') !== null;
      analysis.semantic.hasFooter = document.querySelector('footer, [role="contentinfo"]') !== null;

      if (!analysis.semantic.hasMain) {
        analysis.semantic.landmarkIssues.push('Missing <main> landmark');
        analysis.a11yScore -= 5;
      }
      if (!analysis.semantic.hasNav) {
        analysis.semantic.landmarkIssues.push('Missing <nav> landmark');
        analysis.a11yScore -= 2;
      }
      if (!analysis.semantic.hasHeader) {
        analysis.semantic.landmarkIssues.push('Missing <header> landmark');
        analysis.a11yScore -= 2;
      }

      // Check for skip link
      const firstLink = document.querySelector('a');
      if (firstLink) {
        const href = firstLink.getAttribute('href');
        const text = firstLink.textContent.toLowerCase();
        analysis.semantic.hasSkipLink = (href && href.startsWith('#') &&
          (text.includes('skip') || text.includes('jump')));
      }

      if (!analysis.semantic.hasSkipLink) {
        analysis.semantic.landmarkIssues.push('Missing skip navigation link');
        analysis.a11yScore -= 3;
      }

      // Interactive elements
      const links = document.querySelectorAll('a[href]');
      for (const link of links) {
        const text = link.textContent.trim();
        const ariaLabel = link.getAttribute('aria-label');
        if (!text && !ariaLabel) {
          analysis.interactive.linksWithoutText++;
          analysis.interactive.issues.push('Link without text content');
          analysis.a11yScore -= 2;
        }

        // Check touch target size
        const rect = link.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 &&
            (rect.width < thresholds.MIN_TOUCH_TARGET_SIZE || rect.height < thresholds.MIN_TOUCH_TARGET_SIZE)) {
          analysis.interactive.smallTouchTargets++;
        }
      }

      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const button of buttons) {
        const text = button.textContent.trim();
        const ariaLabel = button.getAttribute('aria-label');
        if (!text && !ariaLabel) {
          analysis.interactive.buttonsWithoutText++;
          analysis.interactive.issues.push('Button without text content');
          analysis.a11yScore -= 3;
        }

        // Check touch target size
        const rect = button.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 &&
            (rect.width < thresholds.MIN_TOUCH_TARGET_SIZE || rect.height < thresholds.MIN_TOUCH_TARGET_SIZE)) {
          analysis.interactive.smallTouchTargets++;
        }
      }

      if (analysis.interactive.smallTouchTargets > 0) {
        analysis.interactive.issues.push(`${analysis.interactive.smallTouchTargets} touch targets smaller than ${thresholds.MIN_TOUCH_TARGET_SIZE}px`);
        analysis.a11yScore -= 3;
      }

      // Image accessibility
      const images = document.querySelectorAll('img');
      analysis.images.totalImages = images.length;

      for (const img of images) {
        const alt = img.getAttribute('alt');
        if (alt !== null) {
          if (alt === '') {
            analysis.images.decorativeImages++;
          } else {
            analysis.images.withAlt++;
          }
        } else {
          analysis.images.withoutAlt++;
          analysis.images.issues.push('Image missing alt attribute');
          analysis.a11yScore -= 3;
        }
      }

      // Ensure score doesn't go below 0
      analysis.a11yScore = Math.max(0, analysis.a11yScore);

      return analysis;
    }, THRESHOLDS);

    return a11yAnalysis;
  }

  async #analyzeContentQuality(chromePage, url, pageHtml) {
    const contentAnalysis = await chromePage.evaluate(({thresholds, htmlContent}) => {
      const analysis = {
        wordCount: 0,
        characterCount: 0,
        paragraphCount: 0,
        sentenceCount: 0,
        avgWordsPerSentence: 0,
        textToHtmlRatio: 0,
        readabilityScore: 0,
        keywords: {},
        topKeywords: [],
        contentScore: 100,
        issues: [],
      };

      // Helper: Calculate Flesch Reading Ease
      function calculateReadability(text, wordCount, sentenceCount) {
        if (wordCount === 0 || sentenceCount === 0) return 0;

        const syllables = text.split(/\s+/).reduce((count, word) => {
          return count + countSyllables(word);
        }, 0);

        const avgWordsPerSentence = wordCount / sentenceCount;
        const avgSyllablesPerWord = syllables / wordCount;

        // Flesch Reading Ease formula
        const score = 206.835 - (1.015 * avgWordsPerSentence) - (84.6 * avgSyllablesPerWord);
        return Math.max(0, Math.min(100, Math.round(score)));
      }

      // Helper: Count syllables in a word (approximation)
      function countSyllables(word) {
        word = word.toLowerCase().replace(/[^a-z]/g, '');
        if (word.length <= 3) return 1;

        const vowels = word.match(/[aeiouy]+/g);
        if (!vowels) return 1;

        let syllableCount = vowels.length;

        // Adjust for silent e
        if (word.endsWith('e')) syllableCount--;
        // Adjust for double vowels
        syllableCount -= (word.match(/[aeiouy]{2,}/g) || []).length * 0.5;

        return Math.max(1, Math.round(syllableCount));
      }

      // Extract main content text
      const mainContent = document.querySelector('main, article, [role="main"]') || document.body;

      // Remove script, style, nav, header, footer from analysis
      const contentClone = mainContent.cloneNode(true);
      const elementsToRemove = contentClone.querySelectorAll('script, style, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');
      elementsToRemove.forEach(el => el.remove());

      const textContent = contentClone.textContent || '';
      const cleanText = textContent.replace(/\s+/g, ' ').trim();

      // Word count
      const words = cleanText.split(/\s+/).filter(word => word.length > 0);
      analysis.wordCount = words.length;
      analysis.characterCount = cleanText.length;

      // Paragraph count
      const paragraphs = contentClone.querySelectorAll('p');
      analysis.paragraphCount = paragraphs.length;

      // Sentence count
      const sentences = cleanText.split(/[.!?]+/).filter(s => s.trim().length > 10);
      analysis.sentenceCount = sentences.length;

      if (analysis.sentenceCount > 0) {
        analysis.avgWordsPerSentence = Math.round(analysis.wordCount / analysis.sentenceCount);
      }

      // Text-to-HTML ratio
      const htmlLength = htmlContent.length;
      const textLength = cleanText.length;
      analysis.textToHtmlRatio = htmlLength > 0 ? Math.round((textLength / htmlLength) * 100) : 0;

      // Readability score
      analysis.readabilityScore = calculateReadability(cleanText, analysis.wordCount, analysis.sentenceCount);

      // Keyword extraction (simple frequency analysis)
      const stopWords = new Set(['the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just', 'him', 'know', 'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give', 'day', 'most', 'us', 'is', 'was', 'are', 'been', 'has', 'had', 'were', 'said', 'did', 'having', 'may', 'should', 'am', 'being', 'more']);

      words.forEach(word => {
        const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (cleanWord.length > 3 && !stopWords.has(cleanWord)) {
          analysis.keywords[cleanWord] = (analysis.keywords[cleanWord] || 0) + 1;
        }
      });

      // Get top 10 keywords
      analysis.topKeywords = Object.entries(analysis.keywords)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({
          word,
          count,
          density: ((count / analysis.wordCount) * 100).toFixed(2)
        }));

      // Check for keyword stuffing
      const maxKeywordDensity = analysis.topKeywords.length > 0 ?
        parseFloat(analysis.topKeywords[0].density) : 0;

      // Content scoring
      if (analysis.wordCount < thresholds.CONTENT_MIN) {
        analysis.issues.push(`Content is too short (${analysis.wordCount} words, minimum: ${thresholds.CONTENT_MIN})`);
        analysis.contentScore -= 20;
      } else if (analysis.wordCount < thresholds.CONTENT_RECOMMENDED) {
        analysis.issues.push(`Content could be longer (${analysis.wordCount} words, recommended: ${thresholds.CONTENT_RECOMMENDED})`);
        analysis.contentScore -= 10;
      }

      if (analysis.textToHtmlRatio < thresholds.TEXT_TO_HTML_RATIO_MIN) {
        analysis.issues.push(`Low text-to-HTML ratio (${analysis.textToHtmlRatio}%, minimum: ${thresholds.TEXT_TO_HTML_RATIO_MIN}%)`);
        analysis.contentScore -= 15;
      }

      if (analysis.paragraphCount < thresholds.PARAGRAPH_MIN) {
        analysis.issues.push(`Too few paragraphs (${analysis.paragraphCount}, minimum: ${thresholds.PARAGRAPH_MIN})`);
        analysis.contentScore -= 10;
      }

      if (analysis.readabilityScore < 30) {
        analysis.issues.push(`Content is very difficult to read (score: ${analysis.readabilityScore}/100)`);
        analysis.contentScore -= 15;
      } else if (analysis.readabilityScore < 50) {
        analysis.issues.push(`Content is difficult to read (score: ${analysis.readabilityScore}/100)`);
        analysis.contentScore -= 10;
      }

      if (analysis.avgWordsPerSentence > 25) {
        analysis.issues.push(`Sentences are too long (avg: ${analysis.avgWordsPerSentence} words, target: ~${thresholds.SENTENCE_AVG_WORDS})`);
        analysis.contentScore -= 5;
      }

      if (maxKeywordDensity > thresholds.KEYWORD_DENSITY_MAX) {
        analysis.issues.push(`Possible keyword stuffing detected (${analysis.topKeywords[0].word}: ${maxKeywordDensity}%)`);
        analysis.contentScore -= 20;
      }

      analysis.contentScore = Math.max(0, analysis.contentScore);

      return analysis;
    }, {thresholds: THRESHOLDS, htmlContent: pageHtml});

    return contentAnalysis;
  }

  async #checkStructuredData(page) {
    return await page.evaluate(() => {
      const result = {
        hasStructuredData: false,
        jsonLdSchemas: [],
        microdataItems: [],
        total: 0,
        validationErrors: [],
        validationWarnings: [],
      };

      // Schema validation rules for common types
      const schemaRules = {
        'Article': {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description']
        },
        'NewsArticle': {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description']
        },
        'BlogPosting': {
          required: ['headline', 'author', 'datePublished'],
          recommended: ['image', 'publisher', 'dateModified', 'description']
        },
        'Product': {
          required: ['name', 'description'],
          recommended: ['image', 'offers', 'aggregateRating', 'brand', 'sku']
        },
        'Organization': {
          required: ['name'],
          recommended: ['url', 'logo', 'contactPoint', 'sameAs', 'address']
        },
        'LocalBusiness': {
          required: ['name', 'address'],
          recommended: ['telephone', 'url', 'openingHours', 'image', 'priceRange']
        },
        'WebPage': {
          required: ['name'],
          recommended: ['description', 'url', 'breadcrumb']
        },
        'WebSite': {
          required: ['name', 'url'],
          recommended: ['description', 'potentialAction']
        },
        'BreadcrumbList': {
          required: ['itemListElement'],
          recommended: []
        },
        'Person': {
          required: ['name'],
          recommended: ['url', 'image', 'jobTitle', 'sameAs']
        },
        'Event': {
          required: ['name', 'startDate', 'location'],
          recommended: ['description', 'image', 'endDate', 'organizer', 'offers']
        },
        'VideoObject': {
          required: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
          recommended: ['duration', 'contentUrl', 'embedUrl', 'publisher']
        },
        'ImageObject': {
          required: ['url'],
          recommended: ['name', 'caption', 'creator']
        },
        'Recipe': {
          required: ['name', 'recipeIngredient', 'recipeInstructions'],
          recommended: ['image', 'author', 'datePublished', 'description', 'prepTime', 'cookTime', 'nutrition']
        },
        'FAQPage': {
          required: ['mainEntity'],
          recommended: []
        },
        'HowTo': {
          required: ['name', 'step'],
          recommended: ['description', 'image', 'totalTime', 'supply', 'tool']
        }
      };

      // Helper function to validate a schema object
      const validateSchema = (schema, type) => {
        const rules = schemaRules[type];
        if (!rules) return; // No validation rules for this type

        const errors = [];
        const warnings = [];

        // Check required fields
        for (const field of rules.required) {
          if (!schema[field]) {
            errors.push(`Missing required field: ${field}`);
          }
        }

        // Check recommended fields
        for (const field of rules.recommended) {
          if (!schema[field]) {
            warnings.push(`Missing recommended field: ${field}`);
          }
        }

        return { errors, warnings };
      };

      // Helper to get nested @type (handles array or string)
      const getSchemaType = (schema) => {
        if (!schema['@type']) return null;
        return Array.isArray(schema['@type']) ? schema['@type'][0] : schema['@type'];
      };

      // Check for JSON-LD
      const jsonLdScripts = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      );

      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const schemas = Array.isArray(data) ? data : [data];

          for (const schema of schemas) {
            const type = getSchemaType(schema);

            if (type) {
              const schemaInfo = {
                type: type,
                context: schema['@context'] || 'unknown',
                raw: schema, // Store full schema for detailed analysis
              };

              // Validate the schema
              const validation = validateSchema(schema, type);
              if (validation) {
                if (validation.errors.length > 0) {
                  schemaInfo.errors = validation.errors;
                  result.validationErrors.push(...validation.errors.map(e => `${type}: ${e}`));
                }
                if (validation.warnings.length > 0) {
                  schemaInfo.warnings = validation.warnings;
                  result.validationWarnings.push(...validation.warnings.map(w => `${type}: ${w}`));
                }
              }

              result.jsonLdSchemas.push(schemaInfo);
            } else if (schema['@graph']) {
              // Handle @graph format (multiple schemas in one script)
              for (const graphItem of schema['@graph']) {
                const graphType = getSchemaType(graphItem);
                if (graphType) {
                  const graphSchemaInfo = {
                    type: graphType,
                    context: schema['@context'] || 'unknown',
                    raw: graphItem,
                  };

                  const validation = validateSchema(graphItem, graphType);
                  if (validation) {
                    if (validation.errors.length > 0) {
                      graphSchemaInfo.errors = validation.errors;
                      result.validationErrors.push(...validation.errors.map(e => `${graphType}: ${e}`));
                    }
                    if (validation.warnings.length > 0) {
                      graphSchemaInfo.warnings = validation.warnings;
                      result.validationWarnings.push(...validation.warnings.map(w => `${graphType}: ${w}`));
                    }
                  }

                  result.jsonLdSchemas.push(graphSchemaInfo);
                }
              }
            }
          }
        } catch (e) {
          result.jsonLdSchemas.push({
            type: 'invalid',
            error: 'Failed to parse JSON-LD: ' + e.message,
          });
          result.validationErrors.push('Invalid JSON-LD syntax');
        }
      }

      // Check for Microdata
      const microdataItems = document.querySelectorAll('[itemscope]');
      for (const item of microdataItems) {
        const itemType = item.getAttribute('itemtype');
        if (itemType) {
          result.microdataItems.push({
            type: itemType.split('/').pop(),
            full: itemType,
          });
        }
      }

      result.total = result.jsonLdSchemas.length + result.microdataItems.length;
      result.hasStructuredData = result.total > 0;

      return result;
    });
  }

  async #checkMobileFriendly(page) {
    return await page.evaluate(() => {
      const issues = [];
      const warnings = [];

      // 1. Check viewport meta tag
      const viewport = document.querySelector('meta[name="viewport"]');
      if (!viewport) {
        issues.push('Missing viewport meta tag');
      } else {
        const content = viewport.content || '';
        if (!content.includes('width=device-width')) {
          issues.push('Viewport meta tag missing width=device-width');
        }
        if (content.includes('user-scalable=no')) {
          warnings.push('Viewport prevents user scaling (accessibility issue)');
        }
      }

      // 2. Check font sizes (minimum 12px recommended)
      const allElements = Array.from(document.querySelectorAll('*'));
      const smallText = allElements.filter(el => {
        if (el.textContent.trim().length === 0) return false;

        const style = window.getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize);
        return fontSize < 12;
      });

      if (smallText.length > 0) {
        issues.push(`${smallText.length} elements with font size smaller than 12px`);
      }

      // 3. Check touch target sizes (minimum 48x48px recommended)
      const interactiveElements = Array.from(
        document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"]')
      );

      const smallTargets = interactiveElements.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 48 || rect.height < 48);
      });

      if (smallTargets.length > 0) {
        issues.push(`${smallTargets.length} touch targets smaller than 48x48px`);
      }

      // 4. Check for content wider than viewport
      const bodyWidth = document.body.scrollWidth;
      const viewportWidth = window.innerWidth;

      if (bodyWidth > viewportWidth + 10) {
        // 10px tolerance
        issues.push('Content is wider than viewport (horizontal scroll required)');
      }

      // 5. Check tap target spacing
      const tooClose = [];
      for (let i = 0; i < interactiveElements.length - 1; i++) {
        const rect1 = interactiveElements[i].getBoundingClientRect();
        const rect2 = interactiveElements[i + 1].getBoundingClientRect();

        // Check if elements are close vertically and horizontally
        const verticalDistance = Math.abs(rect1.bottom - rect2.top);
        const horizontalDistance = Math.abs(rect1.right - rect2.left);

        if ((verticalDistance < 8 && horizontalDistance < 100) ||
            (horizontalDistance < 8 && verticalDistance < 100)) {
          tooClose.push(`${interactiveElements[i].tagName} and ${interactiveElements[i + 1].tagName}`);
        }
      }

      if (tooClose.length > 0) {
        warnings.push(`${tooClose.length} pairs of tap targets too close together`);
      }

      return {
        isMobileFriendly: issues.length === 0,
        issues,
        warnings,
        issueCount: issues.length,
        warningCount: warnings.length,
      };
    });
  }

  async #checkCaching(chromePage, requests, url) {
    const cachingAnalysis = {
      hasCDN: false,
      cdnProvider: null,
      htmlCacheable: false,
      staticCached: 0,
      staticUncached: 0,
      hasServiceWorker: false,
      cacheScore: 0,
      issues: [],
    };

    // 1. Check for CDN usage via headers and domains
    const cdnIndicators = {
      headers: ['cf-ray', 'x-cache', 'x-amz-cf-id', 'x-cdn', 'server', 'via'],
      domains: ['cloudflare', 'cloudfront', 'fastly', 'akamai', 'cdn77', 'maxcdn', 'bunnycdn', 'keycdn'],
      providers: {
        'cf-ray': 'Cloudflare',
        'x-amz-cf-id': 'CloudFront',
        'fastly': 'Fastly',
        'akamai': 'Akamai',
      }
    };

    // Check response headers for CDN indicators
    for (const [reqUrl, reqData] of Object.entries(requests)) {
      const headers = reqData.headers || {};

      // Check CDN headers
      for (const header of cdnIndicators.headers) {
        if (headers[header]) {
          cachingAnalysis.hasCDN = true;
          // Identify provider
          for (const [indicator, provider] of Object.entries(cdnIndicators.providers)) {
            if (header === indicator || headers[header]?.toLowerCase().includes(indicator)) {
              cachingAnalysis.cdnProvider = provider;
              break;
            }
          }
        }
      }

      // Check CDN domains in URLs
      for (const domain of cdnIndicators.domains) {
        if (reqUrl.includes(domain)) {
          cachingAnalysis.hasCDN = true;
          if (!cachingAnalysis.cdnProvider) {
            cachingAnalysis.cdnProvider = domain.charAt(0).toUpperCase() + domain.slice(1);
          }
        }
      }
    }

    // 2. Check HTML page caching
    const pageResponse = requests[url];
    if (pageResponse?.headers) {
      const cacheControl = pageResponse.headers['cache-control'] || '';
      const expires = pageResponse.headers['expires'];
      const etag = pageResponse.headers['etag'];

      cachingAnalysis.htmlCacheable = (
        cacheControl.includes('max-age') ||
        cacheControl.includes('public') ||
        expires ||
        etag
      ) && !cacheControl.includes('no-store') && !cacheControl.includes('no-cache');
    }

    // 3. Analyze static resources caching
    const staticExtensions = ['.js', '.css', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico'];

    for (const [reqUrl, reqData] of Object.entries(requests)) {
      const isStatic = staticExtensions.some(ext => reqUrl.toLowerCase().includes(ext));

      if (isStatic) {
        const headers = reqData.headers || {};
        const cacheControl = headers['cache-control'] || '';
        const expires = headers['expires'];
        const etag = headers['etag'];

        const isCached = (
          (cacheControl && (cacheControl.includes('max-age') || cacheControl.includes('public'))) ||
          expires ||
          etag
        ) && !cacheControl.includes('no-store') && !cacheControl.includes('no-cache');

        if (isCached) {
          cachingAnalysis.staticCached++;
        } else {
          cachingAnalysis.staticUncached++;
          if (cachingAnalysis.staticUncached <= 5) {
            cachingAnalysis.issues.push(`Uncached: ${reqUrl.substring(0, 50)}...`);
          }
        }
      }
    }

    // 4. Check for Service Worker
    try {
      cachingAnalysis.hasServiceWorker = await chromePage.evaluate(() => {
        return 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;
      });
    } catch (error) {
      // Service worker check failed, assume false
      cachingAnalysis.hasServiceWorker = false;
    }

    // 5. Calculate caching effectiveness score (0-100)
    let score = 0;

    // CDN usage: +30 points
    if (cachingAnalysis.hasCDN) score += 30;

    // HTML cacheability: +10 points
    if (cachingAnalysis.htmlCacheable) score += 10;

    // Static resources caching: up to 40 points
    const totalStatic = cachingAnalysis.staticCached + cachingAnalysis.staticUncached;
    if (totalStatic > 0) {
      const cachingRatio = cachingAnalysis.staticCached / totalStatic;
      score += Math.round(cachingRatio * 40);
    }

    // Service Worker: +20 points
    if (cachingAnalysis.hasServiceWorker) score += 20;

    cachingAnalysis.cacheScore = score;

    return cachingAnalysis;
  }

  async #checkIndexability(chromePage, parsedPage, url, statusCode) {
    const indexabilityData = {
      isIndexable: true,
      blockingFactors: [],
      warnings: [],
      metaRobots: null,
      xRobotsTag: null,
      statusCode: statusCode,
      canonicalPointsElsewhere: false,
      hasNoindexTag: false,
      hasNofollowTag: false,
      blockedByRobotsTxt: false,
    };

    // 1. Check HTTP status code
    if (statusCode && statusCode >= 400) {
      indexabilityData.isIndexable = false;
      indexabilityData.blockingFactors.push(`HTTP ${statusCode} error`);
    }

    // 2. Check meta robots tag
    const robotsMeta = parsedPage.querySelector('meta[name="robots"]');
    const contentValue = robotsMeta?.getAttribute('content')?.toLowerCase() || '';
    indexabilityData.metaRobots = contentValue || null;

    if (contentValue) {
      if (contentValue.includes('noindex')) {
        indexabilityData.isIndexable = false;
        indexabilityData.hasNoindexTag = true;
        indexabilityData.blockingFactors.push('Meta robots: noindex');
      }
      if (contentValue.includes('nofollow')) {
        indexabilityData.hasNofollowTag = true;
        indexabilityData.warnings.push('Meta robots: nofollow (links won\'t be followed)');
      }
      if (contentValue.includes('none')) {
        indexabilityData.isIndexable = false;
        indexabilityData.hasNoindexTag = true;
        indexabilityData.hasNofollowTag = true;
        indexabilityData.blockingFactors.push('Meta robots: none (noindex + nofollow)');
      }
    }

    // 3. Check X-Robots-Tag HTTP header
    let response = chromePage.response;
    if (!response) {
      try {
        response = await chromePage.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        // If we can't get response, we already have statusCode
      }
    }

    const headers = await response?.headers() || {};
    const xRobotsTag = headers['x-robots-tag'] || headers['X-Robots-Tag'];

    if (xRobotsTag) {
      indexabilityData.xRobotsTag = xRobotsTag.toLowerCase();

      if (xRobotsTag.toLowerCase().includes('noindex')) {
        indexabilityData.isIndexable = false;
        indexabilityData.hasNoindexTag = true;
        indexabilityData.blockingFactors.push('X-Robots-Tag: noindex');
      }
      if (xRobotsTag.toLowerCase().includes('nofollow')) {
        indexabilityData.hasNofollowTag = true;
        indexabilityData.warnings.push('X-Robots-Tag: nofollow');
      }
    }

    // 4. Check if canonical points elsewhere (soft blocking)
    const canonicalTag = parsedPage.querySelector('link[rel="canonical"]');
    const canonicalUrl = canonicalTag?.getAttribute('href');

    if (canonicalUrl) {
      // Normalize URLs for comparison
      const normalizedCanonical = canonicalUrl.split('#')[0].replace(/\/$/, '');
      const normalizedCurrent = url.split('#')[0].replace(/\/$/, '');

      if (normalizedCanonical !== normalizedCurrent && !normalizedCurrent.includes(normalizedCanonical)) {
        indexabilityData.canonicalPointsElsewhere = true;
        indexabilityData.warnings.push(`Canonical points to different page: ${canonicalUrl}`);
      }
    }

    // 5. Check viewport meta (mobile indexing consideration)
    const viewportMeta = parsedPage.querySelector('meta[name="viewport"]');
    if (!viewportMeta) {
      indexabilityData.warnings.push('Missing viewport meta tag (mobile-first indexing concern)');
    }

    // 6. Check for pagination without proper rel tags
    const hasPagination = parsedPage.querySelector('[href*="page="], [href*="/page/"]');
    if (hasPagination) {
      const hasRelNext = parsedPage.querySelector('link[rel="next"]');
      const hasRelPrev = parsedPage.querySelector('link[rel="prev"]');
      if (!hasRelNext && !hasRelPrev) {
        indexabilityData.warnings.push('Pagination detected but missing rel="next/prev" tags');
      }
    }

    return indexabilityData;
  }

  async #checkSocialMediaTags(chromePage, parsedPage, url) {
    const socialData = {
      hasOpenGraph: false,
      hasTwitterCard: false,
      openGraph: {},
      twitterCard: {},
      issues: [],
      warnings: [],
    };

    // Extract Open Graph tags
    const ogTags = {
      'og:title': null,
      'og:description': null,
      'og:image': null,
      'og:url': null,
      'og:type': null,
      'og:site_name': null,
      'og:locale': null,
      'og:image:width': null,
      'og:image:height': null,
      'og:image:alt': null,
    };

    for (const property in ogTags) {
      const tag = parsedPage.querySelector(`meta[property="${property}"]`);
      if (tag) {
        ogTags[property] = tag.getAttribute('content');
        socialData.hasOpenGraph = true;
      }
    }

    socialData.openGraph = ogTags;

    // Extract Twitter Card tags
    const twitterTags = {
      'twitter:card': null,
      'twitter:title': null,
      'twitter:description': null,
      'twitter:image': null,
      'twitter:image:alt': null,
      'twitter:site': null,
      'twitter:creator': null,
    };

    for (const name in twitterTags) {
      const tag = parsedPage.querySelector(`meta[name="${name}"]`);
      if (tag) {
        twitterTags[name] = tag.getAttribute('content');
        socialData.hasTwitterCard = true;
      }
    }

    socialData.twitterCard = twitterTags;

    // Validation 1: Check required Open Graph tags
    if (!ogTags['og:title']) {
      socialData.issues.push('Missing og:title (required for Facebook sharing)');
    } else if (ogTags['og:title'].length > 60) {
      socialData.warnings.push(`og:title is ${ogTags['og:title'].length} chars (recommended: <60 chars)`);
    }

    if (!ogTags['og:description']) {
      socialData.issues.push('Missing og:description (required for Facebook sharing)');
    } else if (ogTags['og:description'].length > 200) {
      socialData.warnings.push(`og:description is ${ogTags['og:description'].length} chars (recommended: <200 chars)`);
    }

    if (!ogTags['og:image']) {
      socialData.issues.push('Missing og:image (required for visual Facebook sharing)');
    } else {
      // Validate image dimensions if provided
      const width = parseInt(ogTags['og:image:width']);
      const height = parseInt(ogTags['og:image:height']);

      if (!ogTags['og:image:width'] || !ogTags['og:image:height']) {
        socialData.warnings.push('Missing og:image:width or og:image:height (recommended for optimization)');
      } else if (width < 1200 || height < 630) {
        socialData.warnings.push(`og:image dimensions (${width}x${height}) below recommended 1200x630`);
      }

      if (!ogTags['og:image:alt']) {
        socialData.warnings.push('Missing og:image:alt (important for accessibility)');
      }
    }

    if (!ogTags['og:url']) {
      socialData.warnings.push('Missing og:url (helps prevent duplicate content in social platforms)');
    } else if (ogTags['og:url'] !== url && !ogTags['og:url'].includes(url.split('?')[0])) {
      socialData.warnings.push(`og:url (${ogTags['og:url']}) doesn't match page URL`);
    }

    if (!ogTags['og:type']) {
      socialData.warnings.push('Missing og:type (helps social platforms understand content type)');
    }

    // Validation 2: Check Twitter Card tags
    if (!twitterTags['twitter:card']) {
      socialData.issues.push('Missing twitter:card (required for Twitter sharing)');
    } else {
      const validCards = ['summary', 'summary_large_image', 'app', 'player'];
      if (!validCards.includes(twitterTags['twitter:card'])) {
        socialData.issues.push(`Invalid twitter:card value: ${twitterTags['twitter:card']} (must be: ${validCards.join(', ')})`);
      }
    }

    if (!twitterTags['twitter:title']) {
      socialData.warnings.push('Missing twitter:title (falls back to og:title, but explicit is better)');
    } else if (twitterTags['twitter:title'].length > 70) {
      socialData.warnings.push(`twitter:title is ${twitterTags['twitter:title'].length} chars (recommended: <70 chars)`);
    }

    if (!twitterTags['twitter:description']) {
      socialData.warnings.push('Missing twitter:description (falls back to og:description)');
    } else if (twitterTags['twitter:description'].length > 200) {
      socialData.warnings.push(`twitter:description is ${twitterTags['twitter:description'].length} chars (recommended: <200 chars)`);
    }

    if (!twitterTags['twitter:image']) {
      socialData.warnings.push('Missing twitter:image (falls back to og:image)');
    }

    if (!twitterTags['twitter:site'] && !twitterTags['twitter:creator']) {
      socialData.warnings.push('Missing twitter:site and twitter:creator (helps with attribution)');
    }

    // Validation 3: Check consistency between regular meta tags and social tags
    const pageTitle = parsedPage.querySelector('title')?.textContent;
    const pageDescription = parsedPage.querySelector('meta[name="description"]')?.getAttribute('content');

    if (pageTitle && ogTags['og:title'] && pageTitle !== ogTags['og:title']) {
      socialData.warnings.push('og:title differs from page <title> (may be intentional)');
    }

    if (pageDescription && ogTags['og:description'] && pageDescription !== ogTags['og:description']) {
      socialData.warnings.push('og:description differs from meta description (may be intentional)');
    }

    // Validation 4: Check image URLs are absolute
    if (ogTags['og:image'] && !ogTags['og:image'].startsWith('http')) {
      socialData.issues.push('og:image must be an absolute URL (starting with http:// or https://)');
    }

    if (twitterTags['twitter:image'] && !twitterTags['twitter:image'].startsWith('http')) {
      socialData.issues.push('twitter:image must be an absolute URL (starting with http:// or https://)');
    }

    return socialData;
  }

  async #checkAnalyticsTracking(chromePage, parsedPage, url) {
    const analyticsData = {
      hasGA4: false,
      hasUniversalAnalytics: false,
      hasGTM: false,
      hasFacebookPixel: false,
      hasLinkedInTag: false,
      hasTwitterPixel: false,
      hasTikTokPixel: false,
      hasPinterestTag: false,
      hasHotjar: false,
      hasMicrosoftClarity: false,
      trackingIds: {
        ga4: [],
        ua: [],
        gtm: [],
        fbPixel: [],
        linkedIn: [],
        twitter: [],
        tiktok: [],
        pinterest: [],
        hotjar: [],
        clarity: [],
      },
      hasCookieConsent: false,
      consentTool: null,
      hasPrivacyPolicy: false,
      issues: [],
      warnings: [],
    };

    // Get page HTML content
    const htmlContent = parsedPage.toString();

    // 1. Check for Google Analytics 4 (GA4)
    const ga4Matches = htmlContent.match(/G-[A-Z0-9]{10,}/g);
    if (ga4Matches) {
      analyticsData.hasGA4 = true;
      analyticsData.trackingIds.ga4 = [...new Set(ga4Matches)];

      if (analyticsData.trackingIds.ga4.length > 1) {
        analyticsData.warnings.push(`Multiple GA4 measurement IDs found: ${analyticsData.trackingIds.ga4.join(', ')}`);
      }
    }

    // Check for gtag.js script
    const hasGtagScript = parsedPage.querySelector('script[src*="googletagmanager.com/gtag/js"]');
    if (hasGtagScript && !analyticsData.hasGA4) {
      analyticsData.warnings.push('gtag.js script loaded but no GA4 measurement ID found');
    }

    // 2. Check for Universal Analytics (legacy)
    const uaMatches = htmlContent.match(/UA-\d{4,10}-\d{1,4}/g);
    if (uaMatches) {
      analyticsData.hasUniversalAnalytics = true;
      analyticsData.trackingIds.ua = [...new Set(uaMatches)];
      analyticsData.warnings.push('Using legacy Universal Analytics (UA). Migrate to GA4 by July 2024');

      if (analyticsData.trackingIds.ua.length > 1) {
        analyticsData.warnings.push(`Multiple UA tracking IDs found: ${analyticsData.trackingIds.ua.join(', ')}`);
      }
    }

    // Check for analytics.js or ga.js
    const hasAnalyticsJs = parsedPage.querySelector('script[src*="google-analytics.com/analytics.js"]') ||
                          parsedPage.querySelector('script[src*="google-analytics.com/ga.js"]');
    if (hasAnalyticsJs && !analyticsData.hasUniversalAnalytics) {
      analyticsData.warnings.push('Google Analytics script loaded but no UA tracking ID found');
    }

    // 3. Check for Google Tag Manager
    const gtmMatches = htmlContent.match(/GTM-[A-Z0-9]{6,}/g);
    if (gtmMatches) {
      analyticsData.hasGTM = true;
      analyticsData.trackingIds.gtm = [...new Set(gtmMatches)];

      if (analyticsData.trackingIds.gtm.length > 1) {
        analyticsData.warnings.push(`Multiple GTM containers found: ${analyticsData.trackingIds.gtm.join(', ')}`);
      }
    }

    // Check GTM placement - should have both <head> and <body> snippets
    if (analyticsData.hasGTM) {
      const gtmHeadScript = parsedPage.querySelector('script[src*="googletagmanager.com/gtm.js"]');
      const gtmBodyNoscript = parsedPage.querySelector('noscript iframe[src*="googletagmanager.com/ns.html"]');

      if (!gtmHeadScript) {
        analyticsData.issues.push('GTM container ID found but missing <head> script snippet');
      }
      if (!gtmBodyNoscript) {
        analyticsData.warnings.push('GTM missing <body> noscript fallback snippet');
      }
    }

    // 4. Check for Facebook/Meta Pixel
    const fbPixelMatches = htmlContent.match(/fbq\s*\(\s*['"]init['"],\s*['"](\d{15,16})['"]/);
    if (fbPixelMatches || htmlContent.includes('connect.facebook.net/en_US/fbevents.js')) {
      analyticsData.hasFacebookPixel = true;
      if (fbPixelMatches) {
        analyticsData.trackingIds.fbPixel.push(fbPixelMatches[1]);
      }
    }

    // 5. Check for LinkedIn Insight Tag
    const linkedInMatches = htmlContent.match(/_linkedin_partner_id\s*=\s*['"](\d+)['"]/);
    if (linkedInMatches || htmlContent.includes('snap.licdn.com/li.lms-analytics/insight.min.js')) {
      analyticsData.hasLinkedInTag = true;
      if (linkedInMatches) {
        analyticsData.trackingIds.linkedIn.push(linkedInMatches[1]);
      }
    }

    // 6. Check for Twitter/X Pixel
    if (htmlContent.includes('twq(') || htmlContent.includes('static.ads-twitter.com/uwt.js')) {
      analyticsData.hasTwitterPixel = true;
      const twitterIdMatches = htmlContent.match(/twq\s*\(\s*['"]init['"],\s*['"]([a-z0-9]+)['"]/);
      if (twitterIdMatches) {
        analyticsData.trackingIds.twitter.push(twitterIdMatches[1]);
      }
    }

    // 7. Check for TikTok Pixel
    if (htmlContent.includes('ttq.') || htmlContent.includes('analytics.tiktok.com')) {
      analyticsData.hasTikTokPixel = true;
      const tiktokIdMatches = htmlContent.match(/ttq\.load\s*\(\s*['"]([A-Z0-9]+)['"]/);
      if (tiktokIdMatches) {
        analyticsData.trackingIds.tiktok.push(tiktokIdMatches[1]);
      }
    }

    // 8. Check for Pinterest Tag
    if (htmlContent.includes('pintrk(') || htmlContent.includes('s.pinimg.com/ct/core.js')) {
      analyticsData.hasPinterestTag = true;
      const pinterestIdMatches = htmlContent.match(/pintrk\s*\(\s*['"]load['"],\s*['"](\d+)['"]/);
      if (pinterestIdMatches) {
        analyticsData.trackingIds.pinterest.push(pinterestIdMatches[1]);
      }
    }

    // 9. Check for Hotjar
    if (htmlContent.includes('hj(') || htmlContent.match(/static\.hotjar\.com\/c\/hotjar-(\d+)\.js/)) {
      analyticsData.hasHotjar = true;
      const hotjarIdMatches = htmlContent.match(/hjid:\s*(\d+)/);
      if (hotjarIdMatches) {
        analyticsData.trackingIds.hotjar.push(hotjarIdMatches[1]);
      }
    }

    // 10. Check for Microsoft Clarity
    if (htmlContent.includes('clarity(') || htmlContent.includes('clarity.ms/tag/')) {
      analyticsData.hasMicrosoftClarity = true;
      const clarityIdMatches = htmlContent.match(/clarity\.ms\/tag\/([a-z0-9]+)/i);
      if (clarityIdMatches) {
        analyticsData.trackingIds.clarity.push(clarityIdMatches[1]);
      }
    }

    // 11. Check for Cookie Consent Tools
    const consentTools = [
      { name: 'OneTrust', patterns: ['cdn.cookielaw.org', 'optanon.blob.core.windows.net'] },
      { name: 'Cookiebot', patterns: ['consent.cookiebot.com'] },
      { name: 'Cookie Consent', patterns: ['cookieconsent.'] },
      { name: 'Osano', patterns: ['cmp.osano.com'] },
      { name: 'Iubenda', patterns: ['cdn.iubenda.com'] },
      { name: 'TrustArc', patterns: ['consent.trustarc.com'] },
      { name: 'Didomi', patterns: ['sdk.privacy-center.org'] },
      { name: 'Termly', patterns: ['app.termly.io/embed'] },
    ];

    for (const tool of consentTools) {
      const hasConsentTool = tool.patterns.some(pattern => htmlContent.includes(pattern));
      if (hasConsentTool) {
        analyticsData.hasCookieConsent = true;
        analyticsData.consentTool = tool.name;
        break;
      }
    }

    // Check for generic cookie consent patterns
    if (!analyticsData.hasCookieConsent) {
      const genericConsentPatterns = [
        /cookie.*consent/i,
        /gdpr.*consent/i,
        /accept.*cookie/i,
        /cookie.*banner/i,
      ];

      for (const pattern of genericConsentPatterns) {
        if (pattern.test(htmlContent)) {
          analyticsData.hasCookieConsent = true;
          analyticsData.consentTool = 'Custom/Unknown';
          break;
        }
      }
    }

    // 12. Check for Privacy Policy link
    const privacyLinks = parsedPage.querySelectorAll('a[href*="privacy"]');
    if (privacyLinks.length > 0) {
      analyticsData.hasPrivacyPolicy = true;
    }

    // Validation: Check if analytics are present but no cookie consent
    const hasAnyTracking = analyticsData.hasGA4 || analyticsData.hasUniversalAnalytics ||
                          analyticsData.hasGTM || analyticsData.hasFacebookPixel ||
                          analyticsData.hasLinkedInTag || analyticsData.hasTwitterPixel ||
                          analyticsData.hasTikTokPixel || analyticsData.hasPinterestTag;

    if (hasAnyTracking && !analyticsData.hasCookieConsent) {
      analyticsData.issues.push('Tracking scripts detected but no cookie consent mechanism found (GDPR/CCPA compliance issue)');
    }

    if (hasAnyTracking && !analyticsData.hasPrivacyPolicy) {
      analyticsData.warnings.push('Tracking scripts detected but no privacy policy link found');
    }

    // Validation: Check if no analytics at all
    if (!hasAnyTracking) {
      analyticsData.warnings.push('No analytics or tracking tools detected (consider adding GA4 for insights)');
    }

    // Validation: Check script placement in <head>
    const headScripts = parsedPage.querySelectorAll('head script');
    const hasAnalyticsInHead = Array.from(headScripts).some(script => {
      const src = script.getAttribute('src') || '';
      const content = script.textContent || '';
      return src.includes('googletagmanager.com') ||
             src.includes('google-analytics.com') ||
             content.includes('gtag(') ||
             content.includes('ga(');
    });

    if (hasAnyTracking && !hasAnalyticsInHead && !analyticsData.hasGTM) {
      analyticsData.warnings.push('Analytics scripts should be placed in <head> for optimal tracking');
    }

    return analyticsData;
  }

  async #checkInternationalSEO(chromePage, parsedPage, url) {
    const intlData = {
      language: null,
      region: null,
      hasLangAttribute: false,
      langAttribute: null,
      contentLanguageHeader: null,
      hasHreflang: false,
      hasXDefault: false,
      hasSelfReferential: false,
      urlStructure: null, // subdomain, subdirectory, or tld
      charset: null,
      issues: [],
      warnings: [],
    };

    // 1. Check HTML lang attribute
    const htmlLang = parsedPage.querySelector('html')?.getAttribute('lang');
    if (htmlLang) {
      intlData.hasLangAttribute = true;
      intlData.langAttribute = htmlLang;

      // Parse language and region (e.g., "en-US" -> language: "en", region: "US")
      const parts = htmlLang.split('-');
      intlData.language = parts[0].toLowerCase();
      if (parts.length > 1) {
        intlData.region = parts[1].toUpperCase();
      }

      // Validate language code (basic ISO 639-1 check)
      if (intlData.language.length !== 2 && intlData.language.length !== 3) {
        intlData.issues.push(`Invalid language code: ${intlData.language}`);
      }
    } else {
      intlData.issues.push('Missing lang attribute on <html> tag');
    }

    // 2. Check Content-Language HTTP header
    let response = chromePage.response;
    if (!response) {
      try {
        response = await chromePage.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        // Continue without response
      }
    }

    const headers = await response?.headers() || {};
    const contentLanguage = headers['content-language'] || headers['Content-Language'];
    if (contentLanguage) {
      intlData.contentLanguageHeader = contentLanguage;

      // Check consistency with HTML lang
      if (htmlLang && contentLanguage.toLowerCase() !== htmlLang.toLowerCase()) {
        intlData.warnings.push(`Content-Language header (${contentLanguage}) doesn't match HTML lang attribute (${htmlLang})`);
      }
    }

    // 3. Check charset
    const metaCharset = parsedPage.querySelector('meta[charset]');
    const metaContentType = parsedPage.querySelector('meta[http-equiv="Content-Type"]');

    if (metaCharset) {
      intlData.charset = metaCharset.getAttribute('charset');
    } else if (metaContentType) {
      const content = metaContentType.getAttribute('content') || '';
      const match = content.match(/charset=([^;]+)/i);
      if (match) {
        intlData.charset = match[1];
      }
    }

    if (!intlData.charset) {
      intlData.issues.push('Missing charset declaration');
    } else if (intlData.charset.toLowerCase() !== 'utf-8') {
      intlData.warnings.push(`Charset is ${intlData.charset}, UTF-8 is recommended for international sites`);
    }

    // 4. Check hreflang implementation
    const hreflangLinks = parsedPage.querySelectorAll('link[rel="alternate"][hreflang]');
    if (hreflangLinks.length > 0) {
      intlData.hasHreflang = true;

      // Check for x-default
      for (const link of hreflangLinks) {
        const hreflang = link.getAttribute('hreflang');
        const href = link.getAttribute('href');

        if (hreflang === 'x-default') {
          intlData.hasXDefault = true;
        }

        // Check for self-referential hreflang
        if (href === url || href.replace(/\/$/, '') === url.replace(/\/$/, '')) {
          intlData.hasSelfReferential = true;
        }

        // Validate hreflang format (language or language-region)
        if (hreflang !== 'x-default') {
          const hreflangParts = hreflang.split('-');
          if (hreflangParts.length > 2) {
            intlData.warnings.push(`Invalid hreflang format: ${hreflang} (should be language or language-region)`);
          }
        }
      }

      // Warn if no x-default for multi-language sites
      if (hreflangLinks.length > 1 && !intlData.hasXDefault) {
        intlData.warnings.push('Missing x-default hreflang for multi-language site');
      }

      // Warn if no self-referential hreflang
      if (!intlData.hasSelfReferential) {
        intlData.warnings.push('Missing self-referential hreflang (page should reference itself)');
      }
    }

    // 5. Detect URL structure for international sites
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const pathname = urlObj.pathname;

      // Check for ccTLD (country-code top-level domain)
      const tldMatch = hostname.match(/\.([a-z]{2})$/i);
      if (tldMatch && tldMatch[1] !== 'com' && tldMatch[1] !== 'org' && tldMatch[1] !== 'net') {
        intlData.urlStructure = 'tld';
      }
      // Check for subdomain (e.g., fr.example.com, en.example.com)
      else if (hostname.split('.').length > 2) {
        const subdomain = hostname.split('.')[0];
        if (subdomain.length === 2 || subdomain.match(/^(en|fr|de|es|it|pt|ja|zh|ko|ru|ar)$/i)) {
          intlData.urlStructure = 'subdomain';
        }
      }
      // Check for subdirectory (e.g., example.com/en/, example.com/fr/)
      else if (pathname.match(/^\/[a-z]{2}(-[A-Z]{2})?(\/|$)/)) {
        intlData.urlStructure = 'subdirectory';
      }
    } catch (e) {
      // Invalid URL, skip structure detection
    }

    // 6. Check for language switcher
    const languageSwitcher = parsedPage.querySelector('[class*="lang"], [id*="lang"], [class*="language"], select[name*="lang"]');
    if (!languageSwitcher && intlData.hasHreflang) {
      intlData.warnings.push('No visible language switcher found (user experience issue)');
    }

    // 7. Check for localized content signals
    const bodyText = parsedPage.querySelector('body')?.textContent || '';

    // Check for currency symbols (localization signal)
    const currencies = {
      '$': 'USD/AUD/CAD',
      '€': 'EUR',
      '£': 'GBP',
      '¥': 'JPY/CNY',
      '₹': 'INR',
      '₽': 'RUB',
      'R$': 'BRL',
    };

    for (const [symbol, currency] of Object.entries(currencies)) {
      if (bodyText.includes(symbol)) {
        intlData.currencyDetected = currency;
        break;
      }
    }

    // 8. Check for date format indicators (localization signal)
    if (bodyText.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) {
      intlData.hasDateFormat = true;
    }

    // 9. Content language detection (basic heuristic)
    const metaDescription = parsedPage.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const title = parsedPage.querySelector('title')?.textContent || '';
    const sampleText = (title + ' ' + metaDescription).toLowerCase();

    // Detect common non-Latin scripts
    if (sampleText.match(/[\u0400-\u04FF]/)) {
      intlData.detectedScript = 'Cyrillic';
    } else if (sampleText.match(/[\u0600-\u06FF]/)) {
      intlData.detectedScript = 'Arabic';
    } else if (sampleText.match(/[\u4E00-\u9FFF]/)) {
      intlData.detectedScript = 'Chinese';
    } else if (sampleText.match(/[\u3040-\u309F\u30A0-\u30FF]/)) {
      intlData.detectedScript = 'Japanese';
    } else if (sampleText.match(/[\uAC00-\uD7AF]/)) {
      intlData.detectedScript = 'Korean';
    } else if (sampleText.match(/[\u0E00-\u0E7F]/)) {
      intlData.detectedScript = 'Thai';
    } else if (sampleText.match(/[\u0900-\u097F]/)) {
      intlData.detectedScript = 'Devanagari';
    }

    return intlData;
  }

  async #checkCrawlability(chromePage, parsedPage, url) {
    const crawlabilityData = {
      isCrawlable: true,
      blockingFactors: [],
      warnings: [],
      hasRobotsTxtBlock: false,
      hasAuthRequired: false,
      redirectChain: [],
      loadTime: 0,
      resourcesBlocked: [],
    };

    // 1. Check response and redirects
    let response = chromePage.response;
    if (!response) {
      try {
        const startTime = Date.now();
        response = await chromePage.goto(url, { waitUntil: 'domcontentloaded' });
        crawlabilityData.loadTime = Date.now() - startTime;
      } catch (error) {
        crawlabilityData.isCrawlable = false;
        crawlabilityData.blockingFactors.push(`Page load failed: ${error.message}`);
        return crawlabilityData;
      }
    }

    // Check redirect chain
    const request = response?.request();
    if (request) {
      let currentRequest = request;
      const redirects = [];

      while (currentRequest.redirectedFrom()) {
        currentRequest = currentRequest.redirectedFrom();
        redirects.unshift(currentRequest.url());
      }

      if (redirects.length > 0) {
        redirects.push(url);
        crawlabilityData.redirectChain = redirects;

        if (redirects.length > 3) {
          crawlabilityData.warnings.push(`Long redirect chain (${redirects.length} redirects)`);
        }
      }
    }

    // 2. Check authentication requirements
    const statusCode = response?.status();
    if (statusCode === 401 || statusCode === 403) {
      crawlabilityData.isCrawlable = false;
      crawlabilityData.hasAuthRequired = true;
      crawlabilityData.blockingFactors.push(`Authentication required (HTTP ${statusCode})`);
    }

    // 3. Check for JavaScript-heavy content (potential crawl issue)
    const bodyContent = parsedPage.querySelector('body')?.textContent?.trim() || '';
    const scriptTags = parsedPage.querySelectorAll('script').length;

    if (scriptTags > 20 && bodyContent.length < 500) {
      crawlabilityData.warnings.push('Page is heavily JavaScript-dependent with minimal HTML content');
    }

    // 4. Check for infinite scroll or lazy loading (crawlability concern)
    const hasInfiniteScroll = parsedPage.querySelector('[data-infinite], .infinite-scroll, [data-lazy-load]');
    if (hasInfiniteScroll) {
      crawlabilityData.warnings.push('Infinite scroll or lazy loading detected (may hide content from crawlers)');
    }

    // 5. Check load time
    if (crawlabilityData.loadTime > 10000) {
      crawlabilityData.warnings.push(`Very slow load time (${Math.round(crawlabilityData.loadTime / 1000)}s) - may timeout for crawlers`);
    }

    // 6. Check for frames/iframes (crawlability issue)
    const iframes = parsedPage.querySelectorAll('iframe');
    if (iframes.length > 5) {
      crawlabilityData.warnings.push(`Many iframes (${iframes.length}) - content may not be indexed`);
    }

    // 7. Check for "crawler traps" - patterns that might confuse crawlers
    const allLinks = parsedPage.querySelectorAll('a[href]');
    let calendarLinks = 0;
    let sortingLinks = 0;

    for (const link of allLinks) {
      const href = link.getAttribute('href') || '';
      if (href.match(/[?&](year|month|date|calendar)=/i)) calendarLinks++;
      if (href.match(/[?&](sort|order|filter)=/i)) sortingLinks++;
    }

    if (calendarLinks > 20) {
      crawlabilityData.warnings.push('Many calendar/date links - potential crawler trap');
    }
    if (sortingLinks > 10) {
      crawlabilityData.warnings.push('Many sorting/filtering links - potential crawler trap');
    }

    return crawlabilityData;
  }

  async #checkSecurity(chromePage, parsedPage, url) {
    const securityIssues = {
      missingHeaders: [],
      insecureCookies: 0,
      mixedContent: 0,
      formsWithoutCSRF: 0,
      inlineScripts: 0,
      securityScore: 0,
    };

    const isHttps = url.startsWith('https://');

    // 1. Check security headers
    let response = chromePage.response;
    if (!response) {
      try {
        response = await chromePage.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        console.log(`Failed to get response for security check at ${url}:`, error.message);
        return securityIssues; // Return empty security data
      }
    }
    const headers = await response?.headers() || {};

    const securityHeaders = {
      'content-security-policy': 'Content-Security-Policy',
      'x-frame-options': 'X-Frame-Options',
      'x-content-type-options': 'X-Content-Type-Options',
      'strict-transport-security': 'Strict-Transport-Security',
      'referrer-policy': 'Referrer-Policy',
    };

    for (const [header, name] of Object.entries(securityHeaders)) {
      if (!headers[header] && !headers[header.toLowerCase()]) {
        securityIssues.missingHeaders.push(name);
      }
    }

    // 2. Check cookies for security attributes
    const cookies = await chromePage.context().cookies();
    for (const cookie of cookies) {
      if (isHttps && !cookie.secure) {
        securityIssues.insecureCookies++;
      }
      if (!cookie.httpOnly && (cookie.name.toLowerCase().includes('session') || cookie.name.toLowerCase().includes('auth'))) {
        securityIssues.insecureCookies++;
      }
    }

    // 3. Check for mixed content (HTTP resources on HTTPS page)
    if (isHttps) {
      const allResources = parsedPage.querySelectorAll('script[src], link[href], img[src], iframe[src]');
      for (const resource of allResources) {
        const src = resource.getAttribute('src') || resource.getAttribute('href');
        if (src && src.startsWith('http://')) {
          securityIssues.mixedContent++;
        }
      }
    }

    // 4. Check forms for CSRF protection
    const forms = parsedPage.querySelectorAll('form');
    for (const form of forms) {
      const method = form.getAttribute('method')?.toLowerCase();
      if (method === 'post') {
        // Check for CSRF token (common patterns)
        const hasCSRFToken = form.querySelectorAll('input').some(input => {
          const name = input.getAttribute('name')?.toLowerCase() || '';
          return name.includes('csrf') || name.includes('token') || name.includes('_token');
        });
        if (!hasCSRFToken) {
          securityIssues.formsWithoutCSRF++;
        }
      }
    }

    // 5. Check for inline scripts (XSS risk)
    const inlineScripts = parsedPage.querySelectorAll('script:not([src])');
    securityIssues.inlineScripts = inlineScripts.length;

    // Calculate security score (0-100)
    let score = 100;
    score -= securityIssues.missingHeaders.length * 10; // -10 per missing header
    score -= securityIssues.insecureCookies * 5; // -5 per insecure cookie
    score -= securityIssues.mixedContent * 3; // -3 per mixed content
    score -= securityIssues.formsWithoutCSRF * 8; // -8 per form without CSRF
    score -= Math.min(securityIssues.inlineScripts, 10) * 2; // -2 per inline script (max 10)
    securityIssues.securityScore = Math.max(0, score);

    return securityIssues;
  }

  async #checkHeadings(parsedPage, page, saveError) {
    // Note: saveError callback is called with (message, detail, severity)
    const hTags = [
      { tag: "h1", count: 0, values: [] },
      { tag: "h2", count: 0, values: [] },
      { tag: "h3", count: 0, values: [] },
      { tag: "h4", count: 0, values: [] },
      { tag: "h5", count: 0, values: [] },
      { tag: "h6", count: 0, values: [] },
    ];

    for (const hTag of hTags) {
      for (const heading of parsedPage.querySelectorAll(hTag.tag)) {
        hTag.count++;

        hTag.values.push(heading.innerText);
      }
    }

    for (let i = 0; i < hTags.length; i++) {
      if (hTags[i].tag === "h1" && hTags[i].count > 1) {
        saveError(
          "Some pages have more than one h1 tag",
          `<a href="${page}">${page}</a> has ${hTags[i].count} h1 tags`,
          SEVERITY.MEDIUM
        );
      }

      if (hTags[i].tag === "h2" && hTags[i].count > THRESHOLDS.H2_COUNT) {
        saveError(
          `Some pages have more than ${THRESHOLDS.H2_COUNT} h2 tags`,
          `<a href="${page}">${page}</a> has ${hTags[i].count} h2 tags`,
          SEVERITY.LOW
        );
      }

      if (hTags[i].count === 0 && i < 5 && hTags[i + 1].count > 0) {
        saveError(
          `Some pages have incorrect h tags structure: preceding tag h${
            i + 1
          } is missing`,
          `<a href="${page}">${page}</a> has incorrect h tags structure: preceding tag h${
            i + 1
          } is missing`,
          SEVERITY.MEDIUM
        );
      }
    }

    return hTags;
  }

  async #withTimeout(promise, timeoutMs, message = "Observer timeout") {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), timeoutMs)
      ),
    ]);
  }

  saveError(generalError, detailedError, severity = SEVERITY.MEDIUM) {
    // Add to overall set
    this.#results.analysis.overall.add(generalError);

    // Add details with severity
    if (detailedError) {
      if (!this.#results.analysis.details[generalError]) {
        this.#results.analysis.details[generalError] = {
          severity: severity,
          count: 0,
          examples: [],
        };
      }

      this.#results.analysis.details[generalError].examples.push(detailedError);
      this.#results.analysis.details[generalError].count++;
    }

    // Ensure bySeverity is initialized
    if (!this.#results.analysis.bySeverity) {
      this.#results.analysis.bySeverity = {
        critical: [],
        high: [],
        medium: [],
        low: [],
      };
    }

    // Ensure the specific severity level array exists
    if (!this.#results.analysis.bySeverity[severity]) {
      this.#results.analysis.bySeverity[severity] = [];
    }

    // Track by severity
    const issueKey = `${generalError} [${severity}]`;
    if (!this.#results.analysis.bySeverity[severity].includes(issueKey)) {
      this.#results.analysis.bySeverity[severity].push(issueKey);

      // Ensure summary object exists
      if (!this.#results.analysis.summary) {
        this.#results.analysis.summary = {
          totalIssues: 0,
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
        };
      }

      // Update summary counts
      this.#results.analysis.summary.totalIssues++;
      this.#results.analysis.summary[`${severity}Count`]++;
    }
  }

  #checkAttempts(url) {
    if (this.#results.pageData.attempts[url] >= THRESHOLDS.RETRY_ATTEMPTS) {
      this.#results.pageData.processedPages.add(url);
    }
  }

  #saveAttempt(url) {
    if (!this.#results.pageData.attempts[url]) {
      this.#results.pageData.attempts[url] = 0;
    }

    this.#results.pageData.attempts[url] += 1;
  }

  /**
   * Calculate and finalize summary statistics using ScoreCalculator
   */
  #calculateSummary() {
    // Use ScoreCalculator module to calculate summary
    const summary = ScoreCalculator.calculateSummary(
      this.#results.analysis,
      this.#results.pageData,
      this.#results.pageData.pages
    );

    this.#results.analysis.summary = summary;

    // Log summary for debugging
    console.log('\n=== Audit Summary ===');
    console.log(`Total Issues: ${summary.totalIssues}`);
    console.log(`  Critical: ${summary.criticalCount}`);
    console.log(`  High: ${summary.highCount}`);
    console.log(`  Medium: ${summary.mediumCount}`);
    console.log(`  Low: ${summary.lowCount}`);
    console.log(`Overall SEO Score: ${summary.overallScore}/100`);
    console.log('====================\n');
  }

  // Removed: All scoring methods now in lib/scoring/score-calculator.js
  // - #calculateOverallScore()
  // - #calculateCategoryScores()
  // - #identifyQuickWins()
  // - #calculateImpactScore()
  // - #parseEffort()
  // - #getFixRecommendations()

  // Removed: #formatElapsedTime() - now using formatElapsedTime() from lib/utils.js

  /**
   * Start timing the audit
   */
  #startTiming() {
    this.#results.timing.startTime = new Date().toISOString();
    console.log(`Audit started at: ${this.#results.timing.startTime}`);
  }

  /**
   * Stop timing the audit and calculate elapsed time
   */
  #stopTiming() {
    this.#results.timing.endTime = new Date().toISOString();
    const startMs = new Date(this.#results.timing.startTime).getTime();
    const endMs = new Date(this.#results.timing.endTime).getTime();
    this.#results.timing.elapsedTime = endMs - startMs;
    this.#results.timing.elapsedTimeFormatted = formatElapsedTime(this.#results.timing.elapsedTime);

    console.log(`\nAudit completed at: ${this.#results.timing.endTime}`);
    console.log(`Total elapsed time: ${this.#results.timing.elapsedTimeFormatted}`);
  }

  // Removed: #readJsonFile() - now using fileManager.readJsonFile()

  async #restoreProgress() {
    try {
      // Check for both .json.gz and .json files
      const gzFile = this.file;
      const jsonFile = this.file.replace(/\.gz$/, '');

      let actualFile;
      if (fs.existsSync(gzFile)) {
        actualFile = gzFile;
      } else if (fs.existsSync(jsonFile)) {
        actualFile = jsonFile;
        console.log(`ℹ️  Found legacy uncompressed file, will convert to compressed format on next save`);
      } else {
        throw new Error(`Progress file not found: ${this.file}`);
      }

      const stats = fs.statSync(actualFile);
      const fileSizeMB = stats.size / (1024 * 1024);

      console.log(`\nRestoring progress from ${actualFile}`);
      console.log(`File size: ${fileSizeMB.toFixed(2)} MB ${actualFile.endsWith('.gz') ? '(compressed)' : '(uncompressed)'}`);

      if (fileSizeMB > 100) {
        console.warn(`\n⚠️  WARNING: Progress file is very large (${fileSizeMB.toFixed(2)} MB)`);
        console.warn(`This may cause memory issues. Consider:`);
        console.warn(`1. Increasing Node.js memory: NODE_OPTIONS="--max-old-space-size=4096" node start.js ...`);
        console.warn(`2. Starting fresh without --proceed flag`);
        console.warn(`3. Splitting the audit into smaller chunks\n`);

        // For very large files, we need more memory
        if (fileSizeMB > 500 && !actualFile.endsWith('.gz')) {
          console.error(`\n❌ ERROR: Uncompressed file is too large (${fileSizeMB.toFixed(2)} MB) to load safely.`);
          console.error(`Please increase Node.js memory limit or start a fresh audit.\n`);
          process.exit(1);
        }
      }

      console.log(`Loading progress data...`);
      const seoData = this.fileManager.readJsonFile(actualFile);

      console.log(`Restoring data structures...`);

      // Handle incoming links format (backward compatibility)
      // Old format: numbers (counts), New format: arrays (URLs)
      let incomingLinks = seoData.pageData.incomingLinks || {};

      console.log(`  - Processing incoming links data...`);
      for (const target in incomingLinks) {
        if (Array.isArray(incomingLinks[target])) {
          // New format: array of URLs - rebuild tracking Map
          this.#incomingLinksTracking.set(target, new Set(incomingLinks[target]));
        } else if (typeof incomingLinks[target] === 'number') {
          // Old format: count only - initialize empty Set (we've lost the URL data)
          this.#incomingLinksTracking.set(target, new Set());
          // Convert to array format for consistency
          incomingLinks[target] = [];
        }
      }

      this.#results = {
        ...seoData,
        pageData: {
          ...seoData.pageData,
          processedPages: new Set(seoData.pageData.processedPages),
          incomingLinks: incomingLinks,
        },
        analysis: {
          ...seoData.analysis,
          overall: new Set(seoData.analysis.overall),
          // Ensure bySeverity is properly initialized
          bySeverity: {
            critical: seoData.analysis.bySeverity?.critical || [],
            high: seoData.analysis.bySeverity?.high || [],
            medium: seoData.analysis.bySeverity?.medium || [],
            low: seoData.analysis.bySeverity?.low || [],
          },
          // Ensure summary is properly initialized
          summary: {
            totalIssues: seoData.analysis.summary?.totalIssues || 0,
            criticalCount: seoData.analysis.summary?.criticalCount || 0,
            highCount: seoData.analysis.summary?.highCount || 0,
            mediumCount: seoData.analysis.summary?.mediumCount || 0,
            lowCount: seoData.analysis.summary?.lowCount || 0,
          },
        },
      };

      // Restore archive part number if it exists
      if (seoData.archiveInfo && seoData.archiveInfo.lastArchivePart) {
        this.archivePartNumber = seoData.archiveInfo.lastArchivePart;
        // Sync with fileManager
        this.fileManager.setArchivePartNumber(this.archivePartNumber);
        console.log(`  - Found ${seoData.archiveInfo.lastArchivePart} archive file(s)`);

        // Load archived pages back into results for final report generation
        for (let i = 1; i <= this.archivePartNumber; i++) {
          const archiveFile = path.join(this.resultsDir, `SEOAnalysis__${this.domainName}__archive_part${i}.json`);
          try {
            console.log(`  - Loading archive part ${i}...`);
            const archiveData = this.fileManager.readJsonFile(archiveFile);

            // Merge archived pages back into results
            this.#results.pageData.pages = {
              ...this.#results.pageData.pages,
              ...archiveData.pages,
            };
          } catch (error) {
            console.warn(`  ⚠️  Could not load archive part ${i}: ${error.message}`);
          }
        }
      }

      console.log(`✓ Progress restored successfully`);
      console.log(`  - Processed pages: ${this.#results.pageData.processedPages.size}`);
      console.log(`  - Total pages in memory: ${Object.keys(this.#results.pageData.pages).length}`);
      console.log(`  - Total URLs in sitemap: ${this.#results.sitemaps.total || 0}\n`);
    } catch (error) {
      console.error(`\n❌ ERROR restoring progress:`, error.message);
      console.error(`File: ${this.file}`);

      if (error.message.includes('JSON') || error.message.includes('parse')) {
        console.error(`\nThe progress file appears to be corrupted.`);
        console.error(`Consider removing it and starting fresh:\n`);
        console.error(`  mv "${this.file}" "${this.file}.backup"`);
        console.error(`  node start.js --origin=... --perf\n`);
      }

      throw error;
    }
  }

  archiveProcessedPages(pagesToArchive) {
    // Use fileManager to archive pages
    this.fileManager.archiveProcessedPages(pagesToArchive);
    // Update local archivePartNumber to stay in sync
    this.archivePartNumber = this.fileManager.getArchivePartNumber();
  }

  saveData() {
    // Separate pages into processed and unprocessed to handle large files
    const processedPages = {};
    const unprocessedPages = {};

    // Optimize page data to reduce JSON size
    for (const url in this.#results.pageData.pages) {
      const page = this.#results.pageData.pages[url];
      const optimizedPage = {
        ...page,
        // Remove full keywords object, keep only topKeywords (limited to 10)
        contentQuality: page.contentQuality ? {
          ...page.contentQuality,
          keywords: undefined, // Remove full keywords map
          topKeywords: (page.contentQuality.topKeywords || []).slice(0, 10),
        } : page.contentQuality,
        // Limit links array to only count and links without text
        links: page.links ? page.links.filter(link => !link.text || link.text.trim() === '') : [],
        linksCount: page.links ? page.links.length : 0,
        // Reduce requests object to just counts and sizes
        requests: page.requests ? {
          totalRequests: Object.keys(page.requests).length,
          byType: Object.entries(page.requests).reduce((acc, [url, req]) => {
            const type = req.resourceType || 'other';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {})
        } : page.requests,
        // Keep metrics but remove timing details if too large
        metrics: page.metrics ? {
          domContentLoaded: page.metrics.domContentLoaded,
          load: page.metrics.load,
          firstPaint: page.metrics.firstPaint,
        } : page.metrics,
      };

      if (this.#results.pageData.processedPages.has(url)) {
        processedPages[url] = optimizedPage;
      } else {
        unprocessedPages[url] = optimizedPage;
      }
    }

    // Estimate size by checking if processed pages should be archived
    const processedPagesCount = Object.keys(processedPages).length;
    const unprocessedPagesCount = Object.keys(unprocessedPages).length;

    // Check if we should archive (when we have many processed pages)
    const shouldArchive = processedPagesCount > 5000 && processedPagesCount > unprocessedPagesCount;

    let dataToSave;
    let dataSizeMB;

    if (shouldArchive) {
      // Create data without processed pages for size check
      dataToSave = JSON.stringify({
        ...this.#results,
        analysis: {
          ...this.#results.analysis,
          overall: Array.from(this.#results.analysis.overall),
          details: this.#results.analysis.details,
        },
        pageData: {
          ...this.#results.pageData,
          pages: unprocessedPages,
          processedPages: Array.from(this.#results.pageData.processedPages),
        },
        archiveInfo: {
          lastArchivePart: this.archivePartNumber,
          archivedPagesCount: 0, // Will be updated if we archive
        },
      });
      dataSizeMB = Buffer.byteLength(dataToSave, 'utf-8') / (1024 * 1024);
    } else {
      // Include all pages
      dataToSave = JSON.stringify({
        ...this.#results,
        analysis: {
          ...this.#results.analysis,
          overall: Array.from(this.#results.analysis.overall),
          details: this.#results.analysis.details,
        },
        pageData: {
          ...this.#results.pageData,
          pages: { ...processedPages, ...unprocessedPages },
          processedPages: Array.from(this.#results.pageData.processedPages),
        },
      });
      dataSizeMB = Buffer.byteLength(dataToSave, 'utf-8') / (1024 * 1024);
    }

    // Check data size before writing

    // Archive processed pages if needed
    if (shouldArchive && processedPagesCount > 0) {
      console.log(`\n📦 Archiving ${processedPagesCount} processed pages...`);
      this.archiveProcessedPages(processedPages);

      // Update the data to save with archive info
      const compactData = JSON.stringify({
        ...this.#results,
        analysis: {
          ...this.#results.analysis,
          overall: Array.from(this.#results.analysis.overall),
          details: this.#results.analysis.details,
        },
        pageData: {
          ...this.#results.pageData,
          pages: unprocessedPages,
          processedPages: Array.from(this.#results.pageData.processedPages),
        },
        archiveInfo: {
          lastArchivePart: this.archivePartNumber,
          archivedPagesCount: processedPagesCount,
        },
      });

      // Use fileManager to write compressed file
      const stats = this.fileManager.writeJsonFile(this.file, JSON.parse(compactData));
      console.log(`✓ Active file size: ${stats.uncompressedSizeMB.toFixed(2)} MB → ${stats.compressedSizeMB.toFixed(2)} MB compressed (${stats.compressionRatio}% reduction)`);
      console.log(`  (${processedPagesCount} pages archived, ${unprocessedPagesCount} remaining)\n`);
    } else if (dataSizeMB >= 500) {
      // Fallback: if still too large, warn but save anyway
      const stats = this.fileManager.writeJsonFile(this.file, JSON.parse(dataToSave));
      console.warn(`\n⚠️  WARNING: Progress file is ${stats.uncompressedSizeMB.toFixed(2)} MB → ${stats.compressedSizeMB.toFixed(2)} MB compressed`);
      console.warn(`This file is very large. Consider increasing archiving threshold.\n`);
    } else {
      // Use fileManager to write compressed file
      const stats = this.fileManager.writeJsonFile(this.file, JSON.parse(dataToSave));
      if (dataSizeMB > 100) {
        console.warn(`⚠️  Progress file: ${stats.uncompressedSizeMB.toFixed(2)} MB → ${stats.compressedSizeMB.toFixed(2)} MB compressed (${stats.compressionRatio}% reduction, ${processedPagesCount + unprocessedPagesCount} pages)`);
      }
    }
  }

  async #analyzeRobotsTxt() {
    // Use RobotsParser module to parse robots.txt
    const result = await RobotsParser.parseRobotsTxt(this.origin);

    // Update results with parsed data
    this.#results.robots.sitemaps = result.sitemaps;
    this.#results.robots["user-agent"] = result.userAgents;

    // Register any errors found during parsing
    result.errors.forEach(error => {
      this.saveError(error.message, error.detail, error.severity);
    });
  }


  async #analyzeSitemaps() {
    // Use SitemapParser module
    const result = await SitemapParser.parseSitemaps(
      this.origin,
      this.#results.robots.sitemaps
    );

    // Store sitemap data
    Object.assign(this.#results.sitemaps, result.sitemaps);
    this.#results.sitemaps.urls = result.urls;
    this.#results.sitemaps.total = result.total;

    // Register all errors
    result.errors.forEach(error => {
      this.saveError(error.message, error.detail, error.severity);
    });
  }

  async #basicTest(page, network, cpu, url) {
    // Removed console.time to avoid conflicts in concurrent processing

    const requests = {};

    let totalResponseSize = 0;

    // Define handlers so we can remove them later
    const requestHandler = async (request) => {
      requests[request.url()] = {
        resourceType: request.resourceType(),
        method: request.method(),
        startTime: Date.now(),
      };
    };

    const responseHandler = async (response) => {
      let size = null;

      try {
        const body = await response.body();
        size = body.length;

        totalResponseSize += size;
      } catch (e) {
        // Body read failed - ignore
      }

      const resUrl = response.url();

      requests[response.url()] = {
        ...requests[resUrl],
        status: response.status(),
        endTime: Date.now(),
        duration: requests[resUrl]?.endTime && requests[resUrl]?.startTime
          ? requests[resUrl].endTime - requests[resUrl].startTime
          : 0,
        size,
      };
    };

    page.on("request", requestHandler);
    page.on("response", responseHandler);

    if (this.#perf) {
      const session = await page.context().newCDPSession(page);

      // Enable performance metrics collection
      await session.send("Performance.enable");

      // Apply CPU throttling if needed
      if (!cpu.noThrottle && cpu.rate) {
        await session.send("Emulation.setCPUThrottlingRate", {
          rate: cpu.rate,
        });
      }

      // Apply network throttling if needed
      if (!network.noThrottle) {
        await session.send("Network.enable");

        await session.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: network.download,
          uploadThroughput: network.upload,
          latency: network.latency,
        });
      }
    }

    // Navigate to the page
    const response = await page.goto(url, { waitUntil: "load" });

    const status = response?.status();

    // Track redirects
    const redirectChain = [];
    let currentResponse = response;
    while (currentResponse) {
      const request = currentResponse.request();
      const redirectedFrom = request.redirectedFrom();
      if (redirectedFrom) {
        redirectChain.unshift({
          url: redirectedFrom.url(),
          status: redirectedFrom.response()?.status() || 'unknown',
        });
        currentResponse = redirectedFrom.response();
      } else {
        break;
      }
    }

    // Add final URL to chain
    if (redirectChain.length > 0) {
      redirectChain.push({
        url: response?.url() || url,
        status: status,
      });
    }

    let vitals = {};

    if (this.#perf) {
      if (status === 200) {
        console.log(`Collect vitals: ${status} ${url}`);

        // Collect performance metrics
        vitals = await this.#collectVitals(page);
      } else {
        console.log(`Error: ${status} ${url}`);
      }
    }

    const metrics = await page.evaluate(() => {
      return {
        nav: performance.getEntriesByType("navigation"),
        resources: performance.getEntriesByType("resource"),
        paint: performance.getEntriesByType("paint"),
      };
    });

    // Removed console.timeEnd to avoid conflicts in concurrent processing

    // Remove event listeners to prevent memory leaks
    page.off("request", requestHandler);
    page.off("response", responseHandler);

    return {
      ...vitals,
      status,
      requests,
      totalResponseSize,
      metrics,
      redirectChain,
    };
  }

  async #collectVitals(page) {
    // Use VitalsCollector module
    return await VitalsCollector.collectVitals(page);
  }

  async #crawlPages({ pagesToCrawl, collectedURLs, uniquePages, addMissing }) {
    let browser;
    try {
      browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 414, height: 896 },
        // deviceScaleFactor: 2, // not working?
      });

      const alternatesErrors = [];
      const uniqueTitles = new Set();
      const uniqueDescriptions = new Set();
      const failedPages = [];
      const discoveredLinksSource = new Map(); // Track which page each discovered URL was found on

      let isMultiLang = false;

      const META_TAGS = [
        "description",
        "keywords",
        "robots",
        "og:type",
        "og:url",
        "og:title",
        "og:description",
        "og:site_name",
        "og:image",
        "twitter:site",
        "twitter:creator",
        "twitter:title",
        "twitter:description",
        "twitter:card",
        "twitter:widgets:new-embed-design",
        "twitter:image:src",
      ];

      // Process pages in batches for parallel execution
      const concurrency = this.#concurrency;

      for (let batchStart = 0; batchStart < pagesToCrawl.length; batchStart += concurrency) {
        const batchEnd = Math.min(batchStart + concurrency, pagesToCrawl.length);
        const batch = pagesToCrawl.slice(batchStart, batchEnd);

        // Process batch in parallel
        await Promise.all(batch.map(async (url, batchIndex) => {
          const i = batchStart + batchIndex;

          if (this.#results.pageData.processedPages.has(url)) {
            return;
          }

          this.saveData();

          console.log(`Processing ${i + 1}/${pagesToCrawl.length}: ${url}`);

        let page = undefined;

        const chromePage = await context.newPage();

        // chromePage.setDefaultTimeout(30000);

        try {
          let messageDetailed = url;

          page = await this.#withTimeout(
            this.#basicTest(
              chromePage,
              this.networkConditions.slow4g,
              this.cpuConditions.normal,
              url
            )
              .then(async (data) => ({ ...data, url }))
              .catch((error) => {
                const messageOverall = `${error.name} ${error.message} ${error.cause}`;
                messageDetailed = `${url} ${messageOverall}`;

                for (const knownError of KNOWN_ERRORS) {
                  if (messageOverall.includes(knownError)) {
                    this.saveError(knownError, messageDetailed, SEVERITY.CRITICAL);
                  } else {
                    this.saveError(messageOverall, messageDetailed, SEVERITY.CRITICAL);
                  }
                }

                console.log(messageDetailed);

                this.#results.pageData.totalWithError += 1;

                if (!this.#results.pageData.byError.crashed) {
                  this.#results.pageData.byError.crashed = [];
                  this.#results.pageData.byError.totalCrashed = 0;
                }

                this.#results.pageData.byError.crashed.push(url);
                this.#results.pageData.byError.totalCrashed += 1;

                this.#saveAttempt(url);

                this.#checkAttempts(url);
              }),
            THRESHOLDS.PAGE_TIMEOUT,
            "Core Web Vitals test failed. Page failed to load " +
              messageDetailed
          );
        } catch (error) {
          console.log(error);

          this.#saveAttempt(url);

          this.#checkAttempts(url);

          this.saveData();

          process.exit(1);
        }

        if (page) {
          const {
            url,
            status,
            TTFB,
            FCP,
            LCP,
            CLS,
            requests,
            totalResponseSize,
            metrics,
            blockers,
            redirectChain,
          } = page;

          this.#results.pageData.pages[url] = {};

          const pageData = this.#results.pageData.pages[url];

          // Store and analyze redirect chain
          pageData.redirectChain = redirectChain;
          pageData.hasRedirects = redirectChain.length > 0;
          pageData.redirectCount = redirectChain.length;

          // Report redirect issues
          if (redirectChain.length > 0) {
            const redirectCount = redirectChain.length - 1; // Exclude final URL
            if (redirectCount > 2) {
              this.saveError(
                `Some pages have too many redirects`,
                `<a href="${url}">${url}</a> has ${redirectCount} redirect(s): ${redirectChain.map(r => r.url).join(' → ')}`,
                SEVERITY.HIGH
              );
            } else if (redirectCount > 0) {
              this.saveError(
                `Some pages have redirects`,
                `<a href="${url}">${url}</a> has ${redirectCount} redirect(s): ${redirectChain.map(r => r.url).join(' → ')}`,
                SEVERITY.MEDIUM
              );
            }
          }

          pageData.status = status;
          pageData.url = url;
          // Track whether URL was found in sitemap or discovered during crawling
          pageData.foundIn = this.#results.sitemaps.urls[url] ? 'sitemap' : 'discovered';
          // If discovered, track which page it was found on
          if (pageData.foundIn === 'discovered' && discoveredLinksSource.has(url)) {
            pageData.discoveredOn = discoveredLinksSource.get(url);
          }

          // Analyze URL structure
          pageData.urlAnalysis = analyzeUrlStructure(url, this.origin);

          // Report URL structure issues
          for (const issue of pageData.urlAnalysis.issues) {
            this.saveError(
              issue.message.split('(')[0].trim(), // Extract general message
              `<a href="${url}">${url}</a>: ${issue.message}`,
              issue.severity
            );
          }

          // Core Web Vitals
          pageData.TTFB = TTFB;
          pageData.FCP = FCP;
          pageData.LCP = LCP;
          pageData.CLS = CLS;

          // Other metrics
          pageData.requests = requests;
          pageData.metrics = metrics;
          pageData.blockers = blockers;
          pageData.totalResponseSize = totalResponseSize;

          if (totalResponseSize > THRESHOLDS.PAGE_SIZE) {
            this.saveError(
              `Some pages size is too big`,
              `This page has size of ${totalResponseSize} bytes <a href="${url}">${url}</a>`,
              SEVERITY.MEDIUM
            );
          }

          const totalNumberOfRequests = Object.keys(requests).length;

          pageData.totalNumberOfRequests = totalNumberOfRequests;

          if (totalNumberOfRequests > THRESHOLDS.REQUEST_COUNT) {
            this.saveError(
              `Some pages have too many requests`,
              `This page has ${totalNumberOfRequests} requests <a href="${url}">${url}</a>`,
              SEVERITY.MEDIUM
            );
          }

          if (status !== 200) {
            this.#results.pageData.totalWithError += 1;

            if (!this.#results.pageData.byError[status]) {
              this.#results.pageData.byError[status] = [];
              this.#results.pageData.byError[`total${status}`] = 0;
            }

            this.#results.pageData.byError[status].push(url);
            this.#results.pageData.byError[`total${status}`] += 1;

            this.#results.pageData.processedPages.add(url);

            this.saveData();

            return; // Skip to next page in batch
          } else {
            this.#results.pageData.totalWithoutError += 1;
          }

          const pageContent = await chromePage.content();
          const parsedPage = parse(pageContent);

          // Save HTML snapshot if flag is enabled
          if (this.#saveHtml) {
            // Create safe directory name using hash to prevent path traversal
            const folderName = `audit_${createSafeFilename(this.origin)}`;
            const folder = path.join(process.cwd(), folderName);

            try {
              fs.mkdirSync(folder, { recursive: true });
            } catch (error) {
              console.error(`Failed to create directory ${folder}:`, error.message);
            }

            // Create safe filename for the page HTML
            const safeFilename = createSafeFilename(url);
            const filePath = path.join(folder, `${safeFilename}.html`);

            try {
              fs.writeFileSync(filePath, pageContent);
            } catch (error) {
              console.error(`Failed to write file ${filePath}:`, error.message);
            }
          }

          const links = [];
          let httpLinksCount = 0;

          for (const link of parsedPage.querySelectorAll("a")) {
            const href = link.attributes.href;
            const text = link.innerText || link.attributes["aria-label"];

            // Skip pure anchor links (e.g., "#section" or just "#")
            if (href?.startsWith('#')) {
              continue;
            }

            // Check if link is internal (starts with origin)
            const isInternal = href?.startsWith(this.origin) || href?.startsWith('/');

            if (isInternal) {
              let fullHref = href;
              // Handle relative URLs
              if (href?.startsWith('/')) {
                try {
                  const baseUrl = new URL(url);
                  fullHref = `${baseUrl.protocol}//${baseUrl.host}${href}`;
                } catch (e) {
                  // Skip if URL construction fails
                  continue;
                }
              }

              // Check HTTPS consistency for internal links
              if (this.origin.startsWith('https://') && fullHref?.startsWith('http://')) {
                httpLinksCount++;
              }

              // Strip hash fragment for URL comparison and crawling
              const hrefWithoutHash = stripHashFragment(fullHref);

              // Track unique incoming links using a Set for efficient deduplication
              if (!this.#incomingLinksTracking.has(hrefWithoutHash)) {
                this.#incomingLinksTracking.set(hrefWithoutHash, new Set());
              }
              // Add source URL to the Set (automatically handles duplicates)
              this.#incomingLinksTracking.get(hrefWithoutHash).add(url);

              // Update links array in results (will be updated after all pages are processed)
              if (!this.#results.pageData.incomingLinks) {
                this.#results.pageData.incomingLinks = {};
              }
              // Store array of source URLs for popup display
              this.#results.pageData.incomingLinks[hrefWithoutHash] = Array.from(this.#incomingLinksTracking.get(hrefWithoutHash));

              if (addMissing) {
                if (!collectedURLs.has(hrefWithoutHash)) {
                  pagesToCrawl.push(hrefWithoutHash);

                  collectedURLs.add(hrefWithoutHash);

                  uniquePages.add(hrefWithoutHash);

                  // Track that this URL was discovered on the current page
                  if (!this.#results.sitemaps.urls[hrefWithoutHash]) {
                    discoveredLinksSource.set(hrefWithoutHash, url);
                  }
                }
              } else if (!uniquePages.has(hrefWithoutHash)) {
                collectedURLs.add(hrefWithoutHash);

                // Track that this URL was discovered on the current page
                if (!this.#results.sitemaps.urls[hrefWithoutHash]) {
                  discoveredLinksSource.set(hrefWithoutHash, url);
                }
              }
            }

            links.push({ text, href, isInternal });

            if (!text) {
              this.saveError(
                `Some pages have links without any text`,
                `The page <a href="${url}">${url}</a> has a link without text "${href}"`,
                SEVERITY.MEDIUM
              );
            }
          }

          // Report HTTPS consistency issues
          if (httpLinksCount > 0) {
            this.saveError(
              `Some pages have HTTP links on HTTPS site`,
              `<a href="${url}">${url}</a> has ${httpLinksCount} internal HTTP link(s) (should use HTTPS)`,
              SEVERITY.HIGH
            );
          }

          pageData.httpLinksCount = httpLinksCount;

          pageData.links = links;

          const title = await chromePage.evaluate(
            () => document.querySelector("title")?.innerText
          );

          // Analyze headings
          const headingResult = await HeadingAnalyzer.analyzeHeadings(parsedPage, url);
          pageData.headings = headingResult;
          for (const issue of headingResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }

          // Analyze images
          pageData.images = await ImageAnalyzer.extractImageAlts(parsedPage);

          // Analyze Link Quality
          const linkQualityResult = await LinkQualityAnalyzer.analyzeLinkQuality(
            chromePage,
            parsedPage,
            url,
            this.origin,
            this.#results.pageData.pages
          );
          pageData.linkAnalysis = linkQualityResult;
          for (const issue of linkQualityResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of linkQualityResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Structured Data (Schema.org)
          const structuredDataResult = await StructuredDataAnalyzer.analyzeStructuredData(chromePage, url);
          pageData.structuredData = structuredDataResult;
          for (const issue of structuredDataResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of structuredDataResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Mobile-Friendliness
          const mobileFriendlyResult = await MobileFriendlyAnalyzer.analyzeMobileFriendly(chromePage, url);
          pageData.mobileFriendly = mobileFriendlyResult;
          for (const issue of mobileFriendlyResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of mobileFriendlyResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Security
          const securityResult = await SecurityAnalyzer.analyzeSecurity(chromePage, parsedPage, url);
          pageData.security = securityResult;
          for (const issue of securityResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of securityResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Indexability
          const indexabilityResult = await IndexabilityAnalyzer.analyzeIndexability(chromePage, parsedPage, url, pageData.status);
          pageData.indexability = indexabilityResult;
          for (const issue of indexabilityResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of indexabilityResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Crawlability
          const crawlabilityResult = await CrawlabilityAnalyzer.analyzeCrawlability(chromePage, parsedPage, url);
          pageData.crawlability = crawlabilityResult;
          for (const issue of crawlabilityResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of crawlabilityResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check International SEO
          const internationalSEOResult = await InternationalSEOAnalyzer.analyzeInternationalSEO(chromePage, parsedPage, url);
          pageData.internationalSEO = internationalSEOResult;
          for (const issue of internationalSEOResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of internationalSEOResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Social Media Tags
          const socialMediaResult = await SocialMediaAnalyzer.analyzeSocialMediaTags(chromePage, parsedPage, url);
          pageData.socialMedia = socialMediaResult;
          for (const issue of socialMediaResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of socialMediaResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Analytics and Tracking
          const analyticsResult = await AnalyticsTrackingAnalyzer.analyzeAnalyticsTracking(chromePage, parsedPage, url);
          pageData.analytics = analyticsResult;
          for (const issue of analyticsResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of analyticsResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Check Caching Effectiveness
          const cachingResult = await CachingAnalyzer.analyzeCaching(chromePage, requests, url);
          pageData.caching = cachingResult;
          for (const issue of cachingResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of cachingResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Performance Optimization Analysis
          const imageOptimizationResult = await ImageOptimizationAnalyzer.analyzeImageOptimization(chromePage, requests, url);
          pageData.imageOptimization = imageOptimizationResult;
          for (const issue of imageOptimizationResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of imageOptimizationResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          const resourceOptimizationResult = await ResourceOptimizationAnalyzer.analyzeResourceOptimization(chromePage, requests, url);
          pageData.resourceOptimization = resourceOptimizationResult;
          for (const issue of resourceOptimizationResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of resourceOptimizationResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Accessibility Analysis
          const accessibilityResult = await AccessibilityAnalyzer.analyzeAccessibility(chromePage, url);
          pageData.accessibility = accessibilityResult;
          for (const issue of accessibilityResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of accessibilityResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }

          // Content Quality Analysis
          const contentQualityResult = await ContentQualityAnalyzer.analyzeContentQuality(chromePage, url, pageContent);
          pageData.contentQuality = contentQualityResult;
          for (const issue of contentQualityResult.issues || []) {
            this.saveError(issue.message, issue.detail, issue.severity);
          }
          for (const warning of contentQualityResult.warnings || []) {
            this.saveError(warning.message, warning.detail, warning.severity);
          }


          // Check Core Web Vitals thresholds
          if (TTFB > THRESHOLDS.TTFB) {
            this.saveError(
              `Some pages have TTFB more than ${THRESHOLDS.TTFB}ms`,
              `The page <a href="${url}">${url}</a> has TTFB ${TTFB}ms (threshold: ${THRESHOLDS.TTFB}ms)`,
              SEVERITY.HIGH
            );
            console.log("TTFB: " + TTFB, url);
          }

          if (FCP > THRESHOLDS.FCP) {
            this.saveError(
              `Some pages have FCP more than ${THRESHOLDS.FCP}ms`,
              `The page <a href="${url}">${url}</a> has FCP ${FCP}ms (threshold: ${THRESHOLDS.FCP}ms)`,
              SEVERITY.HIGH
            );
            console.log("FCP: " + FCP, url);
          }

          if (LCP > THRESHOLDS.LCP) {
            this.saveError(
              `Some pages have LCP more than ${THRESHOLDS.LCP}ms`,
              `The page <a href="${url}">${url}</a> has LCP ${LCP}ms (threshold: ${THRESHOLDS.LCP}ms)`,
              SEVERITY.HIGH
            );
            console.log("LCP: " + LCP, url);
          }

          if (CLS > THRESHOLDS.CLS) {
            this.saveError(
              `Some pages have CLS more than ${THRESHOLDS.CLS}`,
              `The page <a href="${url}">${url}</a> has CLS ${CLS} (threshold: ${THRESHOLDS.CLS})`,
              SEVERITY.HIGH
            );
            console.log("CLS: " + CLS, url);
          }

          if (!title) {
            this.saveError(
              `Title is missing`,
              `Title is missing for this page <a href="${url}">${url}</a>`,
              SEVERITY.CRITICAL
            );
          } else {
            pageData.title = title;
            const titleLength = title.length;
            pageData.titleLength = titleLength;

            // Check title length
            if (titleLength < THRESHOLDS.TITLE_MIN) {
              this.saveError(
                `Some pages have titles that are too short`,
                `The page <a href="${url}">${url}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
                SEVERITY.MEDIUM
              );
            } else if (titleLength > THRESHOLDS.TITLE_MAX) {
              this.saveError(
                `Some pages have titles that are too long`,
                `The page <a href="${url}">${url}</a> has title length ${titleLength} chars (recommended: ${THRESHOLDS.TITLE_MIN}-${THRESHOLDS.TITLE_MAX})`,
                SEVERITY.MEDIUM
              );
            }

            if (uniqueTitles.has(title)) {
              this.saveError(
                `Some pages have identical titles`,
                `Title "${title}" is duplicated for this page <a href="${url}">${url}</a>`,
                SEVERITY.HIGH
              );
            }

            uniqueTitles.add(title);
          }

          pageData.meta = [];

          for (const metaTag of await chromePage.evaluate(() =>
            Array.from(document.querySelectorAll("meta")).map((meta) => ({
              name: meta.name || meta.getAttribute("property"),
              content: meta.content,
            }))
          )) {
            const name = metaTag.name;
            const content = metaTag.content;

            for (const tag of META_TAGS) {
              if (name === tag) {
                pageData.meta.push({ [tag]: content });

                // Check description length and uniqueness
                if (name === "description") {
                  const descLength = content ? content.length : 0;
                  pageData.descriptionLength = descLength;

                  if (descLength < THRESHOLDS.DESCRIPTION_MIN) {
                    this.saveError(
                      `Some pages have descriptions that are too short`,
                      `The page <a href="${url}">${url}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
                      SEVERITY.MEDIUM
                    );
                  } else if (descLength > THRESHOLDS.DESCRIPTION_MAX) {
                    this.saveError(
                      `Some pages have descriptions that are too long`,
                      `The page <a href="${url}">${url}</a> has description length ${descLength} chars (recommended: ${THRESHOLDS.DESCRIPTION_MIN}-${THRESHOLDS.DESCRIPTION_MAX})`,
                      SEVERITY.MEDIUM
                    );
                  }

                  if (uniqueDescriptions.has(content)) {
                    this.saveError(
                      `Some pages have identical descriptions`,
                      `Description "${content}" is duplicated for this page <a href="${url}">${url}</a>`,
                      SEVERITY.HIGH
                    );
                  }

                  uniqueDescriptions.add(content);
                }
              }
            }
          }

          if (pageData?.meta?.length !== META_TAGS.length) {
            for (const tag of META_TAGS) {
              if (
                !pageData?.meta?.some((pageMeta) =>
                  Object.keys(pageMeta).some((pageTag) => pageTag === tag)
                )
              ) {
                this.saveError(
                  `Meta tag ${tag} is missing`,
                  `Meta tag ${tag} is missing for this page <a href="${url}">${url}</a>`,
                  SEVERITY.MEDIUM
                );
              } else if (tag === "keywords") {
                // TODO: check if keywords are used in title, description, headings
              }
            }
          }

          for (const link of await chromePage.evaluate(() =>
            Array.from(document.querySelectorAll("link")).map((link) => ({
              rel: link.rel,
              hrefLang: link.hrefLang,
              href: link.href,
            }))
          )) {
            const rel = link.rel;

            if (rel === "canonical") {
              pageData.canonical = link.href;
            }

            if (rel === "alternate") {
              // TODO: add other detection methods
              if (link.hrefLang && link.hrefLang !== "x-default") {
                isMultiLang = true;
              }

              if (!pageData.alternates) {
                pageData.alternates = [];
              }

              pageData.alternates.push({
                hreflang: link.hrefLang,
                href: link.href,
              });
            }
          }

          if (!pageData.canonical) {
            this.saveError(
              `Canonicals are not set for some pages`,
              `Canonical link is missing for this page <a href="${url}">${url}</a>`,
              SEVERITY.HIGH
            );
          }

          if (isMultiLang && !pageData.alternates) {
            this.saveError(
              `Alternates are not set for some pages`,
              `Alternates links are missing for this page <a href="${url}">${url}</a>`,
              SEVERITY.MEDIUM
            );
          } else if (pageData.alternates) {
            for (const alternate of pageData.alternates) {
              const count = pageData.alternates.reduce((acc, cur) => {
                if (cur.href === alternate.href) {
                  return (acc += 1);
                }

                return acc;
              }, 0);

              if (count > 1) {
                this.saveError(
                  `Some alternates are duplicated in head links`,
                  `Alternate ${alternate.href} is duplicated for this page <a href="${url}">${url}</a>`,
                  SEVERITY.MEDIUM
                );
              }
            }
          }

          const matchingCanonical =
            this.#results.sitemaps.urls[pageData.canonical] ||
            this.#results.sitemaps.urls[`${this.origin}/${pageData.canonical}`];

          if (matchingCanonical) {
            if (matchingCanonical.alternates) {
              if (pageData.alternates) {
                for (const pageAlternate of pageData.alternates) {
                  if (!matchingCanonical.alternates[pageAlternate.href]) {
                    this.saveError(
                      `Some alternates from sitemap don't match alternates from pages`,
                      `Alternate ${pageAlternate.href} has no match in sitemap for loc ${pageData.canonical} for this page <a href="${url}">${url}</a>`,
                      SEVERITY.MEDIUM
                    );
                  }
                }
              }

              if (Array.isArray(pageData.alternates)) {
                for (const pageAlternate of pageData.alternates) {
                  const sitemapAlternate =
                    matchingCanonical.alternates[pageAlternate.href];

                  if (sitemapAlternate) {
                    if (sitemapAlternate.hreflang !== pageAlternate.hreflang) {
                      this.saveError(
                        `Some alternate hreflangs from sitemap don't match alternate hreflangs from pages`,
                        `Alternate hreflangs ${pageAlternate.hreflang} doesn't match sitemap hreflang ${sitemapAlternate.hreflang} for loc ${pageData.canonical} for this page <a href="${url}">${url}</a>`,
                        SEVERITY.MEDIUM
                      );
                    }
                  }
                }
              }
            }
          } else {
            this.saveError(
              `Some loc and canonical don't match`,
              `No matching loc corresponding canonical ${pageData.canonical} is found for this page <a href="${url}">${url}</a>`,
              SEVERITY.HIGH
            );
          }

          this.#results.pageData.processedPages.add(url);

          this.saveData();
        } else {
          console.log(`Page ${url} was not loaded`);

          this.saveError(
            `Some pages were not loaded.`,
            `Page <a href="${url}">${url}</a> was not loaded`
          );

          failedPages.push(url);
        }

        await chromePage.close();
        })); // End of Promise.all batch processing
      } // End of batch loop

      // After all pages are crawled, populate incoming links count for each page
      for (const url in this.#results.pageData.pages) {
        // Get incoming links array and count
        const incomingLinksArray = this.#results.pageData.incomingLinks[url] || [];
        const incomingLinksCount = Array.isArray(incomingLinksArray) ? incomingLinksArray.length : 0;
        this.#results.pageData.pages[url].incomingLinksCount = incomingLinksCount;
        this.#results.pageData.pages[url].hasIncomingLinks = incomingLinksCount > 0;
      }

      return { alternatesErrors, isMultiLang, failedPages };
    } catch (error) {
      console.log(error);
      throw error; // Re-throw to ensure caller knows something went wrong
    } finally {
      // Always close browser to prevent resource leaks
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.error("Failed to close browser:", closeError);
        }
      }
    }
  }

  async #analyzePages() {
    const uniquePages = new Set(Object.keys(this.#results.sitemaps.urls));
    const collectedURLs = new Set();
    const pagesToCrawl = Array.from(uniquePages);

    // Check if site is already detected as multilanguage from previously crawled pages or sitemap
    let isMultiLang = this.#results.isMultiLang || false;
    if (!isMultiLang) {
      // Check sitemap for alternates
      for (const url in this.#results.sitemaps.urls) {
        const sitemapEntry = this.#results.sitemaps.urls[url];
        if (sitemapEntry.alternates && Object.keys(sitemapEntry.alternates).length > 0) {
          // Check if any alternate has a valid hreflang (not x-default)
          const hasValidAlternate = Object.values(sitemapEntry.alternates).some(
            alt => alt.hreflang && alt.hreflang !== 'x-default'
          );
          if (hasValidAlternate) {
            isMultiLang = true;
            console.log(`Detected multilanguage site from sitemap entry: ${url}`);
            break;
          }
        }
      }
    }

    if (!isMultiLang) {
      // Check existing pages for alternates
      for (const url in this.#results.pageData.pages) {
        const page = this.#results.pageData.pages[url];
        if (page.alternates && page.alternates.length > 0) {
          // Check if any alternate has a valid hreflang (not x-default)
          const hasValidAlternate = page.alternates.some(alt => alt.hreflang && alt.hreflang !== 'x-default');
          if (hasValidAlternate) {
            isMultiLang = true;
            console.log(`Detected multilanguage site from previously crawled page: ${url}`);
            break;
          }
        }
      }
    }

    console.log("Crawling pages from sitemap...");

    const crawledData = await this.#crawlPages({
      pagesToCrawl,
      collectedURLs,
      uniquePages,
    });

    let alternatesErrors = crawledData.alternatesErrors;
    isMultiLang = isMultiLang || crawledData.isMultiLang;
    let failedPages = crawledData.failedPages;

    if (collectedURLs.size) {
      this.saveError(`Some URLs are not listed in sitemap`, null, SEVERITY.MEDIUM);

      console.log("Crawling pages that are missing in sitemap...");

      const crawledData = await this.#crawlPages({
        pagesToCrawl: Array.from(collectedURLs),
        collectedURLs,
        uniquePages,
        addMissing: true,
      });

      alternatesErrors = crawledData.alternatesErrors;
      isMultiLang = isMultiLang || crawledData.isMultiLang;
      failedPages = [...crawledData.failedPages, ...failedPages];
    }

    // Store multilanguage flag in results
    this.#results.isMultiLang = isMultiLang;

    // Add isMultiLang flag to each page
    for (const url in this.#results.pageData.pages) {
      this.#results.pageData.pages[url].isMultiLang = isMultiLang;
    }

    // Identify orphaned pages (pages without incoming links from other pages)
    let orphanedPagesCount = 0;
    for (const url in this.#results.pageData.pages) {
      const page = this.#results.pageData.pages[url];
      // Page is orphaned if it has no incoming links and is in the sitemap
      if (!page.hasIncomingLinks && page.foundIn === 'sitemap') {
        orphanedPagesCount++;
        this.saveError(
          `Some pages have no incoming links from other pages`,
          `The page <a href="${url}">${url}</a> is only accessible through the sitemap (no internal links point to it)`,
          SEVERITY.MEDIUM
        );
      }
    }

    if (orphanedPagesCount > 0) {
      console.log(`Found ${orphanedPagesCount} orphaned pages (only in sitemap, no incoming links)`);
    }

    if (failedPages.length) {
      fs.writeFileSync(path.join(this.resultsDir, "failedPages.json"), JSON.stringify(failedPages));
    }

    if (isMultiLang && alternatesErrors.length) {
      for (const alternatesError of alternatesErrors) {
        this.saveError(
          `Alternates are not set for some pages`,
          alternatesError,
          SEVERITY.MEDIUM
        );
      }
    }

    this.#results.pageData.total = uniquePages.size;
    this.#results.pageData.isMultiLang = isMultiLang;
  }


  async audit() {
    try {
      if (this.#proceed) {
        console.log("Proceeding...");

        await this.#restoreProgress();

        // Keep the original start time from previous run
        if (!this.#results.timing.startTime) {
          this.#startTiming();
        } else {
          console.log(`Resuming audit started at: ${this.#results.timing.startTime}`);
        }

        await this.#analyzePages();
      } else {
        // Start timing for new audit
        this.#startTiming();

        await this.#analyzeRobotsTxt();

        await this.#analyzeSitemaps();

        await this.#analyzePages();
      }
    } catch (error) {
      this.saveError(error, null, SEVERITY.HIGH);

      // Stop timing before exit
      this.#stopTiming();

      // Calculate summary even on error
      this.#calculateSummary();

      // Save data before exiting
      this.saveData();

      console.error('Audit failed with error:', error.message);
      process.exit(1); // Exit with error code to trigger automatic restart
    }

    // Site-wide validation: Check for duplicate titles and descriptions
    const duplicateResult = DuplicateChecker.checkDuplicates(this.#results.pageData.pages);
    for (const issue of duplicateResult.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of duplicateResult.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: International SEO consistency
    const internationalSEOValidation = InternationalSEOValidator.validateInternationalSEOConsistency(this.#results.pageData.pages, this.#results.isMultiLang);
    for (const issue of internationalSEOValidation.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of internationalSEOValidation.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: Hreflang consistency
    const hreflangValidation = InternationalSEOValidator.validateHreflangConsistency(this.#results.pageData.pages);
    for (const issue of hreflangValidation.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of hreflangValidation.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: Structured data consistency
    const structuredDataValidation = StructuredDataValidator.validateStructuredDataConsistency(this.#results.pageData.pages);
    for (const issue of structuredDataValidation.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of structuredDataValidation.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: Indexability and crawlability
    const indexabilityValidation = IndexabilityValidator.validateIndexabilityCrawlability(this.#results.pageData.pages);
    for (const issue of indexabilityValidation.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of indexabilityValidation.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: Link structure
    const linkStructureResult = LinkStructureAnalyzer.analyzeLinkStructure(this.#results.pageData.pages, this.origin);
    for (const issue of linkStructureResult.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of linkStructureResult.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: Social media implementation
    const socialMediaValidation = SocialMediaValidator.validateSocialMediaImplementation(this.#results.pageData.pages);
    for (const issue of socialMediaValidation.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of socialMediaValidation.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Site-wide validation: Analytics and tracking implementation
    const analyticsValidation = AnalyticsValidator.validateAnalyticsImplementation(this.#results.pageData.pages);
    for (const issue of analyticsValidation.issues || []) {
      this.saveError(issue.message, issue.detail, issue.severity);
    }
    for (const warning of analyticsValidation.warnings || []) {
      this.saveError(warning.message, warning.detail, warning.severity);
    }

    // Stop timing
    this.#stopTiming();

    // Calculate final summary statistics
    this.#calculateSummary();

    this.saveData();
  }
}

async function audit() {
  try {
    const { validateArguments, validateURL } = require('./validators');

    // Parse command-line arguments
    const args = parseArgs(process.argv.slice(2));

    // Validate arguments
    const validation = validateArguments(args);
    if (!validation.valid) {
      console.error("");
      console.error(`❌ ${validation.error}`);
      console.error("");
      console.error("Usage: node robots.js --origin=<website-url> [--proceed] [--perf] [--concurrency=<number>]");
      console.error("");
      console.error("Options:");
      console.error("  --origin=<url>          Website URL to audit (required, must be http:// or https://)");
      console.error("  --proceed               Resume from saved progress (optional)");
      console.error("  --perf                  Enable performance metrics collection (optional)");
      console.error("  --concurrency=<number>  Number of pages to crawl in parallel (1-20, default: 5)");
      console.error("");
      console.error("Examples:");
      console.error("  node robots.js --origin=https://example.com");
      console.error("  node robots.js --origin=https://example.com --perf");
      console.error("  node robots.js --origin=https://example.com --concurrency=10");
      console.error("  node robots.js --origin=https://example.com --proceed --perf");
      console.error("");
      process.exit(1);
    }

    // Additional URL validation
    const urlValidation = validateURL(args.origin);
    if (!urlValidation.valid) {
      console.error("");
      console.error(`❌ Invalid URL: ${urlValidation.error}`);
      console.error("");
      process.exit(1);
    }

    console.log(`✅ URL validated: ${args.origin}`);
    console.log(`🔄 Concurrency: ${args.concurrency} pages at a time`);

    const seo = new SEOData(args.origin, args.proceed, args.perf, args.saveHtml, args.concurrency);

    await seo.audit();

    // Save to history for tracking
    try {
      const { HistoryManager } = require('./historyManager');
      const manager = new HistoryManager(seo.domainName);
      manager.addAuditSnapshot(seo.data, seo.fileManager.timestamp);
    } catch (error) {
      console.log('⚠️  Could not save audit history:', error.message);
    }

    // Generate HTML report in the same directory as the JSON file
    const htmlOutputPath = seo.fileManager.getHtmlFilePath();
    generateHTML(seo.file, seo.domainName, htmlOutputPath);
  } catch (error) {
    console.error("Error during audit:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

audit();
