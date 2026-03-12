/**
 * PWA (Progressive Web App) Analyzer
 * Checks manifest, service worker, and installability requirements
 */

import { SEVERITY } from '../../constants';
import type { Issue, PageInfo } from '../../types';

// Required manifest fields for installability
const REQUIRED_MANIFEST_FIELDS = ['name', 'icons', 'start_url', 'display'];

// Recommended manifest fields
const RECOMMENDED_MANIFEST_FIELDS = [
  'short_name', 'description', 'theme_color', 'background_color',
  'orientation', 'scope', 'lang',
];

// Required icon sizes for different platforms
const REQUIRED_ICON_SIZES = [192, 512];
// Recommended icon sizes: [48, 72, 96, 144, 168, 192, 256, 512]

class PWAAnalyzer {
  /**
   * Analyze PWA features for a page
   * @param {object} pageData - Page data
   * @param {string} url - Page URL
   * @returns {object} Analysis results
   */
  static analyze(pageData: PageInfo, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info = {
      hasManifest: false,
      manifestUrl: null as string | null,
      manifestValid: false,
      manifestFields: {} as Record<string, any>,
      hasServiceWorker: false,
      serviceWorkerScope: null as string | null,
      isInstallable: false,
      installabilityIssues: [] as string[],
      hasThemeColor: false,
      hasAppleTouchIcon: false,
      httpsRequired: false,
      offlineCapable: false,
    };

    // Check HTTPS (required for PWA)
    try {
      info.httpsRequired = new URL(url).protocol === 'https:';
    } catch {}

    if (!info.httpsRequired) {
      issues.push({
        message: 'PWA requires HTTPS',
        detail: 'Progressive Web Apps require HTTPS. Service workers will not register on HTTP.',
        severity: SEVERITY.HIGH,
      });
      info.installabilityIssues.push('Site not served over HTTPS');
    }

    // Check for manifest
    const manifestLink = pageData.manifest || pageData.webManifest;
    if (manifestLink) {
      info.hasManifest = true;
      info.manifestUrl = typeof manifestLink === 'string' ? manifestLink : manifestLink.href;

      // Analyze manifest content if available
      const manifestContent = pageData.manifestContent || manifestLink.content;
      if (manifestContent) {
        this.analyzeManifest(manifestContent, info, issues, warnings);
      } else {
        warnings.push({
          message: 'Web manifest not parsed',
          detail: `Manifest found at ${info.manifestUrl} but content not available for analysis.`,
          severity: SEVERITY.LOW,
        });
      }
    } else {
      warnings.push({
        message: 'No web app manifest',
        detail: 'Add a web manifest for PWA features. Create manifest.json and link it with <link rel="manifest">.',
        severity: SEVERITY.LOW,
      });
      info.installabilityIssues.push('No web app manifest');
    }

    // Check for service worker
    if (pageData.serviceWorker || pageData.hasServiceWorker) {
      info.hasServiceWorker = true;
      info.serviceWorkerScope = pageData.serviceWorkerScope || '/';

      // Check if service worker provides offline support
      if (pageData.serviceWorkerFeatures?.offline) {
        info.offlineCapable = true;
      }
    } else {
      warnings.push({
        message: 'No service worker detected',
        detail: 'Service workers enable offline support, push notifications, and background sync. Consider implementing one.',
        severity: SEVERITY.LOW,
      });
      info.installabilityIssues.push('No service worker');
    }

    // Check for theme-color meta tag
    if (pageData.themeColor || pageData.metaTags?.['theme-color']) {
      info.hasThemeColor = true;
    } else {
      warnings.push({
        message: 'No theme-color meta tag',
        detail: 'Add <meta name="theme-color" content="#color"> for browser UI customization.',
        severity: SEVERITY.LOW,
      });
    }

    // Check for Apple touch icon
    if (pageData.appleTouchIcon || pageData.icons?.appleTouchIcon) {
      info.hasAppleTouchIcon = true;
    } else {
      warnings.push({
        message: 'No Apple touch icon',
        detail: 'Add <link rel="apple-touch-icon" href="icon.png"> for iOS home screen.',
        severity: SEVERITY.LOW,
      });
    }

    // Determine installability
    info.isInstallable = info.hasManifest &&
                         info.manifestValid &&
                         info.hasServiceWorker &&
                         info.httpsRequired &&
                         info.installabilityIssues.length === 0;

    if (!info.isInstallable && info.installabilityIssues.length > 0) {
      warnings.push({
        message: 'App not installable',
        detail: `Missing requirements: ${info.installabilityIssues.join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }

  /**
   * Analyze manifest content
   * @param {object|string} manifest - Manifest content
   * @param {object} info - Info object to update
   * @param {Array} issues - Issues array
   * @param {Array} warnings - Warnings array
   */
  static analyzeManifest(manifest: Record<string, any>, info: Record<string, any>, issues: Issue[], warnings: Issue[]) {
    let manifestData;

    try {
      manifestData = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
    } catch (error: unknown) {
      issues.push({
        message: 'Invalid manifest JSON',
        detail: `Manifest could not be parsed: ${(error as Error).message}`,
        severity: SEVERITY.MEDIUM,
      });
      info.installabilityIssues.push('Invalid manifest JSON');
      return;
    }

    info.manifestFields = Object.keys(manifestData);
    info.manifestValid = true;

    // Check required fields
    const missingRequired = REQUIRED_MANIFEST_FIELDS.filter(field => !manifestData[field]);
    if (missingRequired.length > 0) {
      issues.push({
        message: 'Manifest missing required fields',
        detail: `Missing: ${missingRequired.join(', ')}. These are required for installability.`,
        severity: SEVERITY.MEDIUM,
      });
      info.manifestValid = false;
      info.installabilityIssues.push(`Missing manifest fields: ${missingRequired.join(', ')}`);
    }

    // Check recommended fields
    const missingRecommended = RECOMMENDED_MANIFEST_FIELDS.filter(
      field => !manifestData[field] && !missingRequired.includes(field)
    );
    if (missingRecommended.length > 0) {
      warnings.push({
        message: 'Manifest missing recommended fields',
        detail: `Consider adding: ${missingRecommended.join(', ')}`,
        severity: SEVERITY.LOW,
      });
    }

    // Check icons
    if (manifestData.icons && Array.isArray(manifestData.icons)) {
      const iconSizes = manifestData.icons
        .map((icon: any) => {
          const sizes = icon.sizes?.split('x') || [];
          return parseInt(sizes[0], 10);
        })
        .filter((size: number) => !isNaN(size));

      // Check for required sizes
      const missingRequiredSizes = REQUIRED_ICON_SIZES.filter(
        size => !iconSizes.includes(size)
      );

      if (missingRequiredSizes.length > 0) {
        issues.push({
          message: 'Manifest missing required icon sizes',
          detail: `Missing ${missingRequiredSizes.join('x, ')}px icons. These are required for installability.`,
          severity: SEVERITY.MEDIUM,
        });
        info.installabilityIssues.push('Missing required icon sizes');
      }

      // Check for maskable icon
      const hasMaskable = manifestData.icons.some(
        (icon: Record<string, string>) => icon.purpose?.includes('maskable')
      );
      if (!hasMaskable) {
        warnings.push({
          message: 'No maskable icon',
          detail: 'Add a maskable icon for adaptive icon support on Android. Use purpose: "maskable" or "any maskable".',
          severity: SEVERITY.LOW,
        });
      }
    } else {
      issues.push({
        message: 'Manifest has no icons',
        detail: 'Icons array is required in manifest for installability.',
        severity: SEVERITY.MEDIUM,
      });
      info.installabilityIssues.push('No icons in manifest');
    }

    // Check display mode
    if (manifestData.display) {
      const validDisplayModes = ['fullscreen', 'standalone', 'minimal-ui', 'browser'];
      if (!validDisplayModes.includes(manifestData.display)) {
        warnings.push({
          message: 'Invalid display mode',
          detail: `"${manifestData.display}" is not valid. Use: ${validDisplayModes.join(', ')}`,
          severity: SEVERITY.LOW,
        });
      }
    }

    // Check start_url
    if (manifestData.start_url && !manifestData.start_url.startsWith('/') && !manifestData.start_url.startsWith('http')) {
      warnings.push({
        message: 'Relative start_url in manifest',
        detail: 'Consider using an absolute path for start_url to ensure consistent behavior.',
        severity: SEVERITY.LOW,
      });
    }

    // Check scope
    if (manifestData.scope && manifestData.start_url) {
      if (!manifestData.start_url.startsWith(manifestData.scope)) {
        warnings.push({
          message: 'start_url outside scope',
          detail: `start_url "${manifestData.start_url}" should be within scope "${manifestData.scope}"`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Check name length
    if (manifestData.name && manifestData.name.length > 45) {
      warnings.push({
        message: 'Manifest name too long',
        detail: `Name "${manifestData.name.substring(0, 30)}..." is ${manifestData.name.length} chars. Keep under 45 for display.`,
        severity: SEVERITY.LOW,
      });
    }

    if (manifestData.short_name && manifestData.short_name.length > 12) {
      warnings.push({
        message: 'Manifest short_name too long',
        detail: `short_name should be under 12 characters for icon labels. Current: ${manifestData.short_name.length} chars.`,
        severity: SEVERITY.LOW,
      });
    }
  }

  /**
   * Analyze PWA features across the site
   * @param {object} pages - All pages data
   * @returns {object} Site-wide analysis
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const stats = {
      pagesWithManifest: 0,
      pagesWithServiceWorker: 0,
      pagesWithThemeColor: 0,
      manifestUrls: new Set(),
      serviceWorkerScopes: new Set(),
      isInstallable: false,
    };

    for (const [_url, pageData] of Object.entries(pages)) {
      if (pageData.manifest || pageData.webManifest) {
        stats.pagesWithManifest++;
        const manifestUrl = typeof pageData.manifest === 'string'
          ? pageData.manifest
          : pageData.manifest?.href || pageData.webManifest;
        if (manifestUrl) stats.manifestUrls.add(manifestUrl);
      }

      if (pageData.serviceWorker || pageData.hasServiceWorker) {
        stats.pagesWithServiceWorker++;
        if (pageData.serviceWorkerScope) {
          stats.serviceWorkerScopes.add(pageData.serviceWorkerScope);
        }
      }

      if (pageData.themeColor || pageData.metaTags?.['theme-color']) {
        stats.pagesWithThemeColor++;
      }
    }

    const totalPages = Object.keys(pages).length;

    // Site-wide issues
    if (stats.pagesWithManifest === 0) {
      warnings.push({
        message: 'No web app manifest found on any page',
        detail: 'Add a manifest for PWA features and installability.',
        severity: SEVERITY.LOW,
      });
    } else if (stats.manifestUrls.size > 1) {
      warnings.push({
        message: 'Multiple different manifest files',
        detail: `Found ${stats.manifestUrls.size} different manifest URLs. Use a single manifest for the entire site.`,
        severity: SEVERITY.LOW,
      });
    }

    if (stats.pagesWithServiceWorker === 0) {
      warnings.push({
        message: 'No service worker detected',
        detail: 'Service workers enable offline support and better performance. Consider implementing one.',
        severity: SEVERITY.LOW,
      });
    }

    // Check manifest consistency
    if (stats.pagesWithManifest > 0 && stats.pagesWithManifest < totalPages) {
      const percentage = ((stats.pagesWithManifest / totalPages) * 100).toFixed(1);
      warnings.push({
        message: 'Manifest not on all pages',
        detail: `Only ${stats.pagesWithManifest}/${totalPages} pages (${percentage}%) link to manifest. Add to all pages for consistent PWA experience.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, stats };
  }
}

export { PWAAnalyzer };