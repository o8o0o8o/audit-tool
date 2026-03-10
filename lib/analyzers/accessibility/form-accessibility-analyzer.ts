/**
 * Form Accessibility Analyzer
 * Analyzes forms for accessibility compliance (WCAG 2.1)
 */

import { SEVERITY } from '../../constants';
import type { Issue, ChromePage, ParsedPage } from '../../types';

class FormAccessibilityAnalyzer {
  /**
   * Analyze form accessibility
   * @param {Object} chromePage - Playwright page object
   * @param {Object} parsedPage - Parsed HTML page
   * @param {string} url - Page URL
   * @returns {Object} Analysis results
   */
  static async analyze(chromePage: ChromePage, parsedPage: ParsedPage, url: string) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    const formData = {
      forms: [] as any[],
      totalForms: 0,
      totalInputs: 0,
      inputsWithoutLabels: 0,
      inputsWithoutAutocomplete: 0,
      formsWithoutAction: 0,
      accessibilityScore: 100,
    };

    // Get all forms
    const forms = parsedPage.querySelectorAll('form');
    formData.totalForms = forms.length;

    if (forms.length === 0) {
      return { issues, warnings, formData };
    }

    // Analyze each form
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      const formAnalysis = await this.#analyzeForm(form, i, chromePage);
      (formData.forms as any[]).push(formAnalysis);

      formData.totalInputs += formAnalysis.inputs.length;
      formData.inputsWithoutLabels += formAnalysis.inputsWithoutLabels;
      formData.inputsWithoutAutocomplete += formAnalysis.inputsWithoutAutocomplete;

      if (!formAnalysis.hasAction) {
        formData.formsWithoutAction++;
      }
    }

    // Generate issues

    // Missing labels (critical for accessibility)
    if (formData.inputsWithoutLabels > 0) {
      issues.push({
        message: 'Form inputs missing labels',
        detail: `<a href="${url}">${url}</a> has ${formData.inputsWithoutLabels} form input(s) without associated labels. This breaks screen reader accessibility.`,
        severity: SEVERITY.HIGH,
      });
    }

    // Missing autocomplete (UX and accessibility)
    const autocompleteInputCount = formData.forms.reduce((sum, f) =>
      sum + f.inputs.filter(i => i.shouldHaveAutocomplete).length, 0
    );
    if (formData.inputsWithoutAutocomplete > 0 && autocompleteInputCount > 0) {
      warnings.push({
        message: 'Form inputs missing autocomplete attribute',
        detail: `<a href="${url}">${url}</a> has ${formData.inputsWithoutAutocomplete} input(s) that could benefit from autocomplete for better UX.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    // Check for specific form issues
    for (const formAnalysis of formData.forms) {
      // Form without submit button
      if (!formAnalysis.hasSubmitButton && formAnalysis.inputs.length > 0) {
        warnings.push({
          message: 'Form without submit button',
          detail: `Form ${formAnalysis.index + 1} on <a href="${url}">${url}</a> has no submit button. Users may not know how to submit.`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Positive tabindex
      if (formAnalysis.hasPositiveTabindex) {
        issues.push({
          message: 'Form uses positive tabindex',
          detail: `Form ${formAnalysis.index + 1} on <a href="${url}">${url}</a> uses positive tabindex values, which disrupts natural tab order.`,
          severity: SEVERITY.MEDIUM,
        });
      }

      // Missing fieldset/legend for grouped inputs
      if (formAnalysis.hasRadioGroups && !formAnalysis.hasFieldset) {
        warnings.push({
          message: 'Radio/checkbox group without fieldset',
          detail: `Form ${formAnalysis.index + 1} has radio/checkbox groups without fieldset/legend, making them harder to understand for screen readers.`,
          severity: SEVERITY.LOW,
        });
      }

      // Required fields without aria-required
      if (formAnalysis.requiredWithoutAria > 0) {
        warnings.push({
          message: 'Required fields missing aria-required',
          detail: `Form ${formAnalysis.index + 1} has ${formAnalysis.requiredWithoutAria} required field(s) without aria-required attribute.`,
          severity: SEVERITY.LOW,
        });
      }

      // Placeholder as label
      if (formAnalysis.placeholderAsLabel > 0) {
        warnings.push({
          message: 'Placeholder used instead of label',
          detail: `Form ${formAnalysis.index + 1} has ${formAnalysis.placeholderAsLabel} input(s) using placeholder as the only label. Placeholders disappear when typing.`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    // Calculate accessibility score
    const totalChecks = formData.totalInputs * 3; // label, autocomplete, aria
    const failedChecks = formData.inputsWithoutLabels * 2 + formData.inputsWithoutAutocomplete;
    formData.accessibilityScore = totalChecks > 0
      ? Math.max(0, Math.round(100 - (failedChecks / totalChecks) * 100))
      : 100;

    return { issues, warnings, formData };
  }

  /**
   * Analyze a single form
   * @private
   */
  static async #analyzeForm(form: any, index: number, chromePage: ChromePage) {
    const analysis = {
      index,
      hasAction: !!form.getAttribute('action'),
      method: form.getAttribute('method') || 'get',
      hasSubmitButton: false,
      hasFieldset: form.querySelectorAll('fieldset').length > 0,
      hasRadioGroups: false,
      hasPositiveTabindex: false,
      inputs: [] as any[],
      inputsWithoutLabels: 0,
      inputsWithoutAutocomplete: 0,
      requiredWithoutAria: 0,
      placeholderAsLabel: 0,
    };

    // Check for submit button
    const submitButton = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    analysis.hasSubmitButton = !!submitButton;

    // Analyze inputs
    const inputs = form.querySelectorAll('input, select, textarea');
    const labelMap = this.#buildLabelMap(form);

    for (const input of inputs) {
      const inputAnalysis = this.#analyzeInput(input, labelMap);
      analysis.inputs.push(inputAnalysis);

      if (!inputAnalysis.hasLabel) {
        analysis.inputsWithoutLabels++;
      }

      if (inputAnalysis.shouldHaveAutocomplete && !inputAnalysis.hasAutocomplete) {
        analysis.inputsWithoutAutocomplete++;
      }

      if (inputAnalysis.isRequired && !inputAnalysis.hasAriaRequired) {
        analysis.requiredWithoutAria++;
      }

      if (inputAnalysis.placeholderAsLabel) {
        analysis.placeholderAsLabel++;
      }

      if (inputAnalysis.tabindex! > 0) {
        analysis.hasPositiveTabindex = true;
      }

      if (inputAnalysis.type === 'radio' || inputAnalysis.type === 'checkbox') {
        analysis.hasRadioGroups = true;
      }
    }

    return analysis;
  }

  /**
   * Build map of label associations
   * @private
   */
  static #buildLabelMap(form: any) {
    const labelMap = new Map();

    // Labels with "for" attribute
    const labels = form.querySelectorAll('label[for]');
    for (const label of labels) {
      const forAttr = label.getAttribute('for');
      if (forAttr) {
        labelMap.set(forAttr, label.textContent.trim());
      }
    }

    return labelMap;
  }

  /**
   * Analyze a single input
   * @private
   */
  static #analyzeInput(input: any, labelMap: Map<string, string>) {
    const type = input.getAttribute('type') || (input.tagName === 'TEXTAREA' ? 'textarea' : 'text');
    const id = input.getAttribute('id');
    const name = input.getAttribute('name');
    const ariaLabel = input.getAttribute('aria-label');
    const ariaLabelledBy = input.getAttribute('aria-labelledby');
    const placeholder = input.getAttribute('placeholder');
    const autocomplete = input.getAttribute('autocomplete');
    const required = input.hasAttribute('required');
    const ariaRequired = input.getAttribute('aria-required') === 'true';
    const tabindex = parseInt(input.getAttribute('tabindex'), 10) || 0;
    const title = input.getAttribute('title');

    // Skip hidden and submit-like inputs
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) {
      return {
        type,
        hasLabel: true,
        shouldHaveAutocomplete: false,
        hasAutocomplete: true,
      };
    }

    // Check for label
    const hasExplicitLabel = id && labelMap.has(id);
    const hasImplicitLabel = input.closest('label') !== null;
    const hasAriaLabel = !!ariaLabel || !!ariaLabelledBy;
    const hasTitle = !!title;
    const hasLabel = hasExplicitLabel || hasImplicitLabel || hasAriaLabel || hasTitle;

    // Check if using placeholder as label (anti-pattern)
    const placeholderAsLabel = !hasLabel && !!placeholder;

    // Determine if autocomplete should be used
    const shouldHaveAutocomplete = this.#shouldHaveAutocomplete(type, name);
    const hasAutocomplete = !!autocomplete && autocomplete !== 'off';

    return {
      type,
      id,
      name,
      hasLabel,
      hasExplicitLabel,
      hasImplicitLabel,
      hasAriaLabel,
      shouldHaveAutocomplete,
      hasAutocomplete,
      autocompleteValue: autocomplete,
      isRequired: required,
      hasAriaRequired: ariaRequired || required, // HTML required implies aria-required
      tabindex,
      placeholderAsLabel,
    };
  }

  /**
   * Determine if input should have autocomplete
   * @private
   */
  static #shouldHaveAutocomplete(type: string, name: string | null) {
    const autocompleteTypes = ['text', 'email', 'tel', 'url', 'password', 'search'];
    const autocompleteNames = [
      'name', 'email', 'phone', 'tel', 'address', 'city', 'state', 'zip', 'postal',
      'country', 'cc', 'card', 'cvv', 'username', 'password', 'fname', 'lname',
      'firstname', 'lastname', 'street', 'organization', 'company',
    ];

    if (!autocompleteTypes.includes(type)) {
      return false;
    }

    if (!name) {
      return false;
    }

    const nameLower = name.toLowerCase();
    return autocompleteNames.some(n => nameLower.includes(n));
  }

  /**
   * Site-wide form accessibility analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, any>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let totalForms = 0;
    let totalInputs = 0;
    let totalInputsWithoutLabels = 0;
    let pagesWithFormIssues = 0;

    for (const [url, page] of Object.entries(pages)) {
      if (page.formData) {
        totalForms += page.formData.totalForms;
        totalInputs += page.formData.totalInputs;
        totalInputsWithoutLabels += page.formData.inputsWithoutLabels;

        if (page.formData.inputsWithoutLabels > 0) {
          pagesWithFormIssues++;
        }
      }
    }

    if (totalInputsWithoutLabels > 0) {
      const percentage = Math.round((totalInputsWithoutLabels / totalInputs) * 100);
      issues.push({
        message: `${totalInputsWithoutLabels} form inputs across site missing labels`,
        detail: `${percentage}% of form inputs lack proper labels. This is a WCAG 2.1 Level A failure affecting screen reader users.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (totalForms > 0 && pagesWithFormIssues > 0) {
      const totalPages = Object.keys(pages).length;
      warnings.push({
        message: `${pagesWithFormIssues} pages have form accessibility issues`,
        detail: `Review forms on these pages to ensure all inputs have associated labels and proper ARIA attributes.`,
        severity: SEVERITY.MEDIUM,
      });
    }

    return { issues, warnings };
  }
}

export { FormAccessibilityAnalyzer };