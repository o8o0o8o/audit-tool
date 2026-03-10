import { THRESHOLDS } from '../../constants';
import type { ChromePage } from '../../types';

class AccessibilityAnalyzer {
  static async analyzeAccessibility(chromePage: ChromePage) {
    const a11yAnalysis = await chromePage.evaluate((thresholds) => {
      const analysis = {
        aria: {
          valid: 0,
          invalid: 0,
          missingLabels: 0,
          issues: [] as string[],
        },
        forms: {
          totalForms: 0,
          inputsWithLabels: 0,
          inputsWithoutLabels: 0,
          missingFieldsets: 0,
          issues: [] as string[],
        },
        keyboard: {
          elementsWithTabindex: 0,
          positiveTabindex: 0,
          elementsWithoutFocus: 0,
          issues: [] as string[],
        },
        semantic: {
          hasMain: false,
          hasNav: false,
          hasHeader: false,
          hasFooter: false,
          hasSkipLink: false as boolean,
          landmarkIssues: [] as string[],
        },
        interactive: {
          linksWithoutText: 0,
          buttonsWithoutText: 0,
          smallTouchTargets: 0,
          issues: [] as string[],
        },
        images: {
          totalImages: 0,
          withAlt: 0,
          withoutAlt: 0,
          decorativeImages: 0,
          issues: [] as string[],
        },
        language: {
          hasLangAttribute: false,
          langValue: null as string | null,
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
        if (validAriaRoles.includes(role!)) {
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
        if (interactiveRoles.includes(role!)) {
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
          analysis.forms.issues.push(`Input without associated label: type="${(input as any).type || 'text'}"`);
          analysis.a11yScore -= 3;
        }
      }

      // Keyboard navigation
      const tabindexElements = document.querySelectorAll('[tabindex]');
      analysis.keyboard.elementsWithTabindex = tabindexElements.length;

      for (const el of tabindexElements) {
        const tabindex = parseInt(el.getAttribute('tabindex')!, 10);
        if (!isNaN(tabindex) && tabindex > 0) {
          analysis.keyboard.positiveTabindex++;
          analysis.keyboard.issues.push(`Element has positive tabindex (${tabindex}), should be 0 or -1`);
          analysis.a11yScore -= 2;
        }
      }

      // Check interactive elements for focus indicators
      const interactiveElements = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"]');
      for (const el of interactiveElements) {
        // Note: getComputedStyle cannot check :focus pseudo-class styles;
        // we check the element's default outline which, if set to none, suggests
        // focus indicators may be suppressed via CSS (outline: none / outline: 0)
        const styles = window.getComputedStyle(el);
        const outlineWidth = styles.outlineWidth;
        const outlineStyle = styles.outlineStyle;

        if (outlineWidth === '0px' || outlineStyle === 'none') {
          const hasCustomFocus = styles.boxShadow !== 'none' || styles.border !== (el as any).style.border;
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
        analysis.semantic.hasSkipLink = !!(href && href.startsWith('#') &&
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
}

export { AccessibilityAnalyzer };