/**
 * Reduced Motion Analyzer
 * Checks for prefers-reduced-motion support and auto-playing animations
 * WCAG 2.3.1 (Three Flashes or Below Threshold), 2.3.3 (Animation from Interactions)
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage } from '../../types';

class ReducedMotionAnalyzer {
  static async analyze(chromePage: ChromePage, _parsedPage: ParsedPage, _url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const info: {
      hasReducedMotionQuery: boolean;
      autoplayVideos: number;
      autoplayVideosWithoutPause: number;
      animatedElements: number;
      carousels: number;
      marqueeElements: number;
    } = {
      hasReducedMotionQuery: false,
      autoplayVideos: 0,
      autoplayVideosWithoutPause: 0,
      animatedElements: 0,
      carousels: 0,
      marqueeElements: 0,
    };

    try {
      const result = await chromePage.evaluate(() => {
        // 1. Check CSS for prefers-reduced-motion media query
        let hasReducedMotion = false;
        try {
          for (const sheet of document.styleSheets) {
            try {
              const rules = sheet.cssRules || sheet.rules;
              for (const rule of rules) {
                if (rule instanceof CSSMediaRule && rule.conditionText?.includes('prefers-reduced-motion')) {
                  hasReducedMotion = true;
                  break;
                }
              }
            } catch {
              // Cross-origin stylesheet, skip
            }
            if (hasReducedMotion) break;
          }
        } catch {
          // StyleSheet access error
        }

        // Also check inline style tags
        if (!hasReducedMotion) {
          const styleTags = document.querySelectorAll('style');
          for (const tag of styleTags) {
            if (tag.textContent?.includes('prefers-reduced-motion')) {
              hasReducedMotion = true;
              break;
            }
          }
        }

        // 2. Check for autoplay videos
        const videos = document.querySelectorAll('video');
        let autoplay = 0;
        let autoplayNoPause = 0;

        for (const video of videos) {
          if (video.autoplay || video.hasAttribute('autoplay')) {
            autoplay++;
            // Check if there's a visible pause/stop control
            const parent = video.parentElement;
            const hasPauseBtn = parent?.querySelector(
              'button, [role="button"], [aria-label*="pause"], [aria-label*="stop"]',
            );
            if (!hasPauseBtn && !video.controls) {
              autoplayNoPause++;
            }
          }
        }

        // 3. Count elements with CSS animations/transitions
        let animatedCount = 0;
        const allElements = document.querySelectorAll('*');
        const sample = Array.from(allElements).slice(0, 300);

        for (const el of sample) {
          const style = window.getComputedStyle(el);
          const animation = style.animationName;
          const duration = parseFloat(style.animationDuration);

          if (animation && animation !== 'none' && duration > 0) {
            const iterationCount = style.animationIterationCount;
            // Only flag infinite or long-running animations
            if (iterationCount === 'infinite' || parseFloat(iterationCount) > 3) {
              animatedCount++;
            }
          }
        }

        // 4. Check for carousel/slider patterns
        const carouselSelectors = [
          '.carousel',
          '.slider',
          '.swiper',
          '.slick',
          '.owl-carousel',
          '[data-carousel]',
          '[data-slider]',
          '.splide',
          '.glide',
          '.flickity',
        ];
        const carousels = document.querySelectorAll(carouselSelectors.join(', ')).length;

        // 5. Check for deprecated marquee element
        const marquees = document.querySelectorAll('marquee').length;

        return {
          hasReducedMotion,
          autoplay,
          autoplayNoPause,
          animatedCount,
          carousels,
          marquees,
        };
      });

      info.hasReducedMotionQuery = result.hasReducedMotion;
      info.autoplayVideos = result.autoplay;
      info.autoplayVideosWithoutPause = result.autoplayNoPause;
      info.animatedElements = result.animatedCount;
      info.carousels = result.carousels;
      info.marqueeElements = result.marquees;
    } catch {
      return { issues, warnings, info };
    }

    // Report issues
    if (info.marqueeElements > 0) {
      issues.push({
        message: 'Deprecated <marquee> element used',
        detail: `${info.marqueeElements} <marquee> element(s) found. This deprecated element creates moving content that cannot be paused and fails WCAG 2.2.2.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (info.autoplayVideosWithoutPause > 0) {
      issues.push({
        message: 'Autoplay video without pause controls',
        detail: `${info.autoplayVideosWithoutPause} video(s) autoplay without visible pause/stop controls. WCAG 2.2.2 requires a mechanism to pause, stop, or hide auto-updating content.`,
        severity: SEVERITY.HIGH,
      });
    }

    const hasAnimations = info.animatedElements > 0 || info.carousels > 0 || info.autoplayVideos > 0;

    if (hasAnimations && !info.hasReducedMotionQuery) {
      issues.push({
        message: 'No prefers-reduced-motion CSS support',
        detail: `Page has ${info.animatedElements} animated element(s), ${info.carousels} carousel(s), and ${info.autoplayVideos} autoplay video(s), but no @media (prefers-reduced-motion) query was found. Users who prefer reduced motion will see all animations.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    if (info.carousels > 0) {
      warnings.push({
        message: 'Auto-playing carousel/slider detected',
        detail: `${info.carousels} carousel/slider component(s) found. Ensure auto-advancing carousels have pause controls and respect prefers-reduced-motion.`,
        severity: SEVERITY.LOW,
      });
    }

    return { issues, warnings, info };
  }
}

export { ReducedMotionAnalyzer };
