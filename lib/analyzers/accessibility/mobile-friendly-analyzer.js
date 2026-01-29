class MobileFriendlyAnalyzer {
  static async analyzeMobileFriendly(page) {
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
}

module.exports = { MobileFriendlyAnalyzer };
