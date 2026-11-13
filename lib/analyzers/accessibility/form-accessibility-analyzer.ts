/**
 * Form Accessibility Analyzer
 * Analyzes forms for accessibility compliance (WCAG 2.1)
 */

import { SEVERITY } from '../../constants';
import { calcPercent, shortenUrl } from '../../utils';
import type { Issue, ChromePage, ParsedPage, PageInfo, FormInput } from '../../types';

interface FormAnalysis {
  index: number;
  hasAction: boolean;
  method: string;
  hasSubmitButton: boolean;
  hasFieldset: boolean;
  hasRadioGroups: boolean;
  hasPositiveTabindex: boolean;
  inputs: FormInput[];
  inputsWithoutLabels: number;
  inputsWithoutAutocomplete: number;
  requiredWithoutAria: number;
  placeholderAsLabel: number;
  /**
   * True only for the unambiguous defect: a form that self-posts via GET AND
   * collects SENSITIVE / personal data — i.e. GET (or defaulted) method AND a
   * non-navigating action (empty / missing / "#" / fragment-only / "javascript:")
   * AND at least one sensitive field (email / password / tel input, a textarea,
   * or a name matching PII patterns). Such a form leaks that data into the URL as
   * query params instead of POSTing to a handler. Deliberately EXCLUDES the
   * legitimate empty-action GET patterns — search boxes, and sort/filter/faceted
   * navigation forms that intentionally keep state in a bookmarkable URL — so it
   * does not re-introduce the false positives this analyzer's finding previously
   * produced.
   */
  selfPostGetDataForm: boolean;
}

/**
 * True when script intercepts the form's submit: an `onsubmit` property/attribute, or a
 * `submit` listener on the form (CDP `DOMDebugger.getEventListeners`). Such forms usually
 * `preventDefault()` and send the data with fetch/XHR, so a missing action/method does not
 * leak fields into the URL. Delegated listeners on `document` are not seen (rare for forms).
 * Errors (closed page, no CDP) count as "no handler" so the finding still fires.
 */
export async function hasJsSubmitHandler(chromePage: ChromePage, index: number, id: string | null): Promise<boolean> {
  try {
    const handle = await chromePage.evaluateHandle(
      ({ index, id }) => (id ? document.getElementById(id) : null) ?? document.querySelectorAll('form')[index] ?? null,
      { index, id },
    );
    const el = handle.asElement();
    if (!el) return false;
    const hasProp = await el.evaluate((f) => typeof (f as HTMLFormElement).onsubmit === 'function');
    if (hasProp) return true;
    const client = await chromePage.context().newCDPSession(chromePage);
    try {
      const { result } = (await client.send('Runtime.evaluate', {
        expression: id ? `document.getElementById(${JSON.stringify(id)})` : `document.querySelectorAll('form')[${index}]`,
      })) as { result: { objectId?: string } };
      if (!result.objectId) return false;
      const { listeners } = (await client.send('DOMDebugger.getEventListeners', { objectId: result.objectId })) as {
        listeners: { type: string }[];
      };
      return listeners.some((l) => l.type === 'submit');
    } finally {
      await client.detach().catch(() => {});
    }
  } catch {
    return false;
  }
}

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
      forms: [] as FormAnalysis[],
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
      formData.forms.push(formAnalysis);

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
    const autocompleteInputCount = formData.forms.reduce(
      (sum: number, f: FormAnalysis) => sum + f.inputs.filter((i: FormInput) => i.shouldHaveAutocomplete).length,
      0,
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
      // Data-collection form self-posting via GET — fields leak to the URL as
      // query params. ONE canonical message (fixed MEDIUM) so the LLM anomaly
      // pass no longer produces varying titles for the same defect (report doc #4).
      if (formAnalysis.selfPostGetDataForm) {
        warnings.push({
          message: 'Form submits to itself via GET',
          detail: `Form ${formAnalysis.index + 1} on <a href="${url}">${url}</a> has an empty or missing action and uses the GET method, so its fields are appended to the current URL as query parameters instead of being sent to a handler. Set an explicit action and use POST for data submission.`,
          severity: SEVERITY.MEDIUM,
        });
      }

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
    formData.accessibilityScore =
      totalChecks > 0 ? Math.max(0, 100 - calcPercent(failedChecks, totalChecks)) : 100;

    return { issues, warnings, formData };
  }

  /**
   * Analyze a single form
   * @private
   */
  static async #analyzeForm(form: ParsedPage, index: number, chromePage: ChromePage): Promise<FormAnalysis> {
    const analysis: FormAnalysis = {
      index,
      hasAction: !!form.getAttribute('action'),
      method: form.getAttribute('method') ?? 'get',
      hasSubmitButton: false,
      hasFieldset: form.querySelectorAll('fieldset').length > 0,
      hasRadioGroups: false,
      hasPositiveTabindex: false,
      inputs: [],
      inputsWithoutLabels: 0,
      inputsWithoutAutocomplete: 0,
      requiredWithoutAria: 0,
      placeholderAsLabel: 0,
      selfPostGetDataForm: false,
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

    // Detect the unambiguous self-post-via-GET defect (see FormAnalysis doc).
    // An empty/missing action + GET is VALID, intentional HTML for search boxes
    // and — crucially — sort/filter/faceted-navigation forms, which deliberately
    // put state in a shareable, bookmarkable, SEO-friendly URL. Flagging those
    // would ADD false positives (the exact thing this run avoids). So we fire
    // ONLY when the form collects SENSITIVE / personal data — the genuine defect
    // is PII (email, password, message, phone, name, address, payment) leaking
    // into the query string. A category/sort/keyword field is not sensitive.
    const actionRaw = (form.getAttribute('action') ?? '').trim();
    const actionLower = actionRaw.toLowerCase();
    const isNonNavigatingAction =
      actionRaw === '' || actionRaw === '#' || actionRaw.startsWith('#') || actionLower.startsWith('javascript:');
    const isGetMethod = analysis.method.trim().toLowerCase() !== 'post'; // GET or defaulted
    // Sensitivity is detected primarily by input TYPE (semantic: email/password/tel)
    // and free-text body (textarea). Name matching is restricted to UNAMBIGUOUS
    // contact/PII tokens — deliberately NOT product/location words like
    // `mobile`/`card`/`phone`/`postal`/`address`/`street`, which double as retail
    // filter and store-locator field names (`mobile_brand`, `card_type`,
    // `postal_code`) and would re-introduce the filter-form false positive.
    const SENSITIVE_INPUT_TYPES = new Set(['email', 'password', 'tel']);
    const SENSITIVE_NAME_RE =
      /(e-?mail|passw|message|comment|enquir|inquir|first-?name|last-?name|full-?name|\bfname\b|\blname\b|cvv|\bcc-|\bssn\b)/i;
    const hasSensitiveField = analysis.inputs.some(
      (i) =>
        (!!i.type && SENSITIVE_INPUT_TYPES.has(i.type)) ||
        i.type === 'textarea' || // a free-text body is a contact/feedback signal, never a filter/search control
        (!!i.name && SENSITIVE_NAME_RE.test(i.name)),
    );
    analysis.selfPostGetDataForm =
      isGetMethod &&
      isNonNavigatingAction &&
      hasSensitiveField &&
      !(await hasJsSubmitHandler(chromePage, index, form.getAttribute('id') ?? null));

    return analysis;
  }

  /**
   * Build map of label associations
   * @private
   */
  static #buildLabelMap(form: ParsedPage) {
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
  static #analyzeInput(input: ParsedPage, labelMap: Map<string, string>): FormInput {
    const type = input.getAttribute('type') ?? (input.tagName === 'TEXTAREA' ? 'textarea' : 'text');
    const id = input.getAttribute('id');
    const name = input.getAttribute('name');
    const ariaLabel = input.getAttribute('aria-label');
    const ariaLabelledBy = input.getAttribute('aria-labelledby');
    const placeholder = input.getAttribute('placeholder');
    const autocomplete = input.getAttribute('autocomplete');
    const required = input.hasAttribute('required');
    const ariaRequired = input.getAttribute('aria-required') === 'true';
    const tabindex = parseInt(input.getAttribute('tabindex') ?? '', 10) || 0;
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
    const hasExplicitLabel = !!(id && labelMap.has(id));
    const hasImplicitLabel = input.closest('label') !== null;
    const hasAriaLabel = !!ariaLabel || !!ariaLabelledBy;
    const hasTitle = !!title;
    const hasLabel = !!(hasExplicitLabel || hasImplicitLabel || hasAriaLabel || hasTitle);

    // Check if using placeholder as label (anti-pattern)
    const placeholderAsLabel = !hasLabel && !!placeholder;

    // Determine if autocomplete should be used
    const shouldHaveAutocomplete = this.#shouldHaveAutocomplete(type, name ?? null);
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
      'name',
      'email',
      'phone',
      'tel',
      'address',
      'city',
      'state',
      'zip',
      'postal',
      'country',
      'cc',
      'card',
      'cvv',
      'username',
      'password',
      'fname',
      'lname',
      'firstname',
      'lastname',
      'street',
      'organization',
      'company',
    ];

    if (!autocompleteTypes.includes(type)) {
      return false;
    }

    if (!name) {
      return false;
    }

    const nameLower = name.toLowerCase();
    return autocompleteNames.some((n) => nameLower.includes(n));
  }

  /**
   * Site-wide form accessibility analysis
   * @param {Object} pages - All pages
   * @returns {Object} Analysis results
   */
  static analyzeSiteWide(pages: Record<string, PageInfo>) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];

    let totalForms = 0;
    let totalInputs = 0;
    let totalInputsWithoutLabels = 0;
    let pagesWithFormIssues = 0;
    const formIssueUrls: string[] = [];

    for (const [url, page] of Object.entries(pages)) {
      if (page.formData) {
        totalForms += page.formData.totalForms ?? 0;
        totalInputs += page.formData.totalInputs ?? 0;
        totalInputsWithoutLabels += page.formData.inputsWithoutLabels ?? 0;

        if ((page.formData.inputsWithoutLabels ?? 0) > 0) {
          pagesWithFormIssues++;
          formIssueUrls.push(url);
        }
      }
    }

    // Only emit the SITE-WIDE "across the site" finding when the problem spans
    // more than one page. For a single page, the per-page "Form inputs missing
    // labels" finding already covers it — emitting both produced a misleading
    // "across the site … (0% of all inputs)" duplicate for a lone input.
    if (totalInputsWithoutLabels > 0 && pagesWithFormIssues > 1) {
      const rawPct = totalInputs > 0 ? (totalInputsWithoutLabels / totalInputs) * 100 : 0;
      // Never render "0%" for a non-zero count — show "<1" when it rounds down.
      const pctLabel = rawPct > 0 && rawPct < 1 ? '<1' : Math.round(rawPct);
      issues.push({
        message: 'Form inputs across the site are missing labels',
        detail: `${totalInputsWithoutLabels} form input(s) across ${pagesWithFormIssues} pages (${pctLabel}% of all inputs) lack proper labels. This is a WCAG 2.1 Level A failure affecting screen reader users.`,
        severity: SEVERITY.HIGH,
      });
    }

    if (totalForms > 0 && pagesWithFormIssues > 0) {
      for (const url of formIssueUrls) {
        warnings.push({
          message: 'Page has form accessibility issues',
          detail: `<a href="${url}">${shortenUrl(url)}</a> — form inputs lack labels or proper ARIA attributes (WCAG 2.1 Level A).`,
          severity: SEVERITY.MEDIUM,
        });
      }
    }

    return { issues, warnings };
  }
}

export { FormAccessibilityAnalyzer };
