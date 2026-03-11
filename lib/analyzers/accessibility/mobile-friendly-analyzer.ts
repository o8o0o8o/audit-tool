import type { ChromePage } from '../../types';

class MobileFriendlyAnalyzer {
  static async analyzeMobileFriendly(page: ChromePage) {
    return await page.evaluate(() => {
      const issues: string[] = [];
      const warnings: string[] = [];
      const metrics: Record<string, any> = {};

      // 1. Check viewport meta tag
      const viewport = document.querySelector('meta[name="viewport"]');
      if (!viewport) {
        issues.push('Missing viewport meta tag');
        metrics.hasViewport = false;
      } else {
        const content = (viewport as HTMLMetaElement).content || '';
        metrics.hasViewport = true;
        metrics.viewportContent = content;

        if (!content.includes('width=device-width')) {
          issues.push('Viewport meta tag missing width=device-width');
        }
        if (content.includes('user-scalable=no')) {
          warnings.push('Viewport prevents user scaling (accessibility issue)');
        }
        if (content.includes('maximum-scale=1')) {
          warnings.push('Viewport limits maximum scale (may affect accessibility)');
        }
        // Check for initial-scale
        if (!content.includes('initial-scale')) {
          warnings.push('Viewport missing initial-scale value');
        }
      }

      // 2. Check font sizes (minimum 12px recommended for readability)
      const textElements = Array.from(document.querySelectorAll('p, span, a, li, td, th, label, div'));
      const smallTextElements = [];
      const fontSizeDistribution = {};

      textElements.forEach(el => {
        const text = el.textContent.trim();
        if (text.length === 0) return;
        // Skip if this element's text is same as parent's (nested elements)
        if (el.parentElement && el.parentElement.textContent.trim() === text) return;

        const style = window.getComputedStyle(el);
        const fontSize = Math.round(parseFloat(style.fontSize));

        if (fontSize < 12 && text.length > 0) {
          smallTextElements.push({
            tag: el.tagName.toLowerCase(),
            fontSize,
            textPreview: text.slice(0, 30),
          });
        }

        // Track distribution
        const bucket = fontSize < 12 ? '<12' : fontSize < 14 ? '12-13' : fontSize < 16 ? '14-15' : '16+';
        (fontSizeDistribution as Record<string, number>)[bucket] = ((fontSizeDistribution as Record<string, number>)[bucket] || 0) + 1;
      });

      metrics.fontSizeDistribution = fontSizeDistribution;
      metrics.smallTextCount = smallTextElements.length;

      if (smallTextElements.length > 0) {
        const percent = textElements.length > 0
          ? ((smallTextElements.length / textElements.length) * 100).toFixed(1)
          : 0;
        issues.push(`${smallTextElements.length} text elements (${percent}%) have font size smaller than 12px`);
      }

      // 3. Check line height for readability
      const bodyStyle = window.getComputedStyle(document.body);
      const bodyLineHeight = parseFloat(bodyStyle.lineHeight);
      const bodyFontSize = parseFloat(bodyStyle.fontSize);
      if (!isNaN(bodyLineHeight) && !isNaN(bodyFontSize)) {
        const lineHeightRatio = bodyLineHeight / bodyFontSize;
        if (lineHeightRatio < 1.4) {
          warnings.push(`Body line-height ratio (${lineHeightRatio.toFixed(2)}) is below recommended 1.4 for readability`);
        }
        metrics.lineHeightRatio = lineHeightRatio;
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
      metrics.tooClosePairs = tooClose.length;

      // 6. Check for fixed positioning elements that might cover content
      const fixedElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return style.position === 'fixed' && (el as HTMLElement).offsetHeight > 0;
      });

      let fixedAreaPercent = 0;
      fixedElements.forEach(el => {
        const rect = el.getBoundingClientRect();
        fixedAreaPercent += (rect.width * rect.height) / (window.innerWidth * window.innerHeight) * 100;
      });

      if (fixedAreaPercent > 30) {
        warnings.push(`Fixed elements cover ${fixedAreaPercent.toFixed(1)}% of viewport (may obstruct content on mobile)`);
      }
      metrics.fixedElementsCount = fixedElements.length;
      metrics.fixedAreaPercent = fixedAreaPercent;

      // 7. Check for text that doesn't wrap properly
      const overflowingText = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, div'))
        .filter(el => el.scrollWidth > el.clientWidth + 5);

      if (overflowingText.length > 0) {
        warnings.push(`${overflowingText.length} elements have text overflow (may be cut off on mobile)`);
      }
      metrics.overflowingTextCount = overflowingText.length;

      // 8. Check for proper media queries (responsive images)
      const images = Array.from(document.querySelectorAll('img'));
      const responsiveImages = images.filter(img =>
        img.srcset || img.sizes || img.closest('picture')
      );
      const nonResponsiveImages = images.length - responsiveImages.length;

      if (images.length > 0 && nonResponsiveImages > images.length * 0.5) {
        warnings.push(`${nonResponsiveImages} of ${images.length} images lack responsive attributes (srcset/sizes)`);
      }
      metrics.responsiveImagesCount = responsiveImages.length;
      metrics.totalImagesCount = images.length;

      return {
        isMobileFriendly: issues.length === 0,
        issues,
        warnings,
        issueCount: issues.length,
        warningCount: warnings.length,
        metrics,
      };
    });
  }
}

export { MobileFriendlyAnalyzer };