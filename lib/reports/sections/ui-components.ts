/**
 * UI Components — Reusable CSS Classes
 * Component classes that reference design tokens for consistent styling.
 * Used across all HTML report section generators.
 */

/**
 * Generate reusable CSS component classes
 * @returns CSS classes referencing design tokens
 */
function getUIComponents(): string {
  return `
    /* ==============================================
       CARDS
       ============================================== */

    .ui-card {
      background: var(--color-bg-surface);
      border: 1px solid var(--color-border-default);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: var(--space-6);
    }

    .ui-card--flush {
      padding: 0;
    }

    .ui-card--muted {
      background: var(--color-bg-page);
      box-shadow: none;
    }

    .ui-card--elevated {
      box-shadow: var(--shadow-md);
    }


    /* ==============================================
       BADGES
       ============================================== */

    .ui-badge {
      display: inline-block;
      padding: 2px var(--space-3);
      border-radius: var(--radius-sm);
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-semibold);
      line-height: var(--line-height-normal);
      white-space: nowrap;
      vertical-align: middle;
    }

    .ui-badge--pill {
      border-radius: var(--radius-full);
      padding: 2px var(--space-4);
    }

    /* Color variants */
    .ui-badge--success {
      background: var(--color-success-bg);
      color: var(--color-success-text);
      border: 1px solid var(--color-success-border);
    }

    .ui-badge--warning {
      background: var(--color-warning-bg);
      color: var(--color-warning-text);
      border: 1px solid var(--color-warning-border);
    }

    .ui-badge--error {
      background: var(--color-error-bg);
      color: var(--color-error-text);
      border: 1px solid var(--color-error-border);
    }

    .ui-badge--info {
      background: var(--color-info-bg);
      color: var(--color-info-text);
      border: 1px solid var(--color-info-border);
    }

    .ui-badge--neutral {
      background: var(--color-bg-surface-alt);
      color: var(--color-text-muted);
      border: 1px solid var(--color-border-default);
    }

    /* Severity variants */
    .ui-badge--critical {
      background: var(--color-severity-critical-bg);
      color: var(--color-severity-critical-text);
      border: 1px solid var(--color-severity-critical-border);
    }

    .ui-badge--high {
      background: var(--color-severity-high-bg);
      color: var(--color-severity-high-text);
      border: 1px solid var(--color-severity-high-border);
    }

    .ui-badge--medium {
      background: var(--color-severity-medium-bg);
      color: var(--color-severity-medium-text);
      border: 1px solid var(--color-severity-medium-border);
    }

    .ui-badge--low {
      background: var(--color-severity-low-bg);
      color: var(--color-severity-low-text);
      border: 1px solid var(--color-severity-low-border);
    }

    /* Status badge (solid bg, white text) */
    .ui-badge--status {
      color: var(--color-text-inverse);
      min-width: 40px;
      text-align: center;
      padding: 3px var(--space-3);
    }


    /* ==============================================
       GRID LAYOUTS
       ============================================== */

    .ui-grid {
      display: grid;
      gap: var(--space-6);
    }

    .ui-grid--2 { grid-template-columns: repeat(2, 1fr); }
    .ui-grid--3 { grid-template-columns: repeat(3, 1fr); }
    .ui-grid--4 { grid-template-columns: repeat(4, 1fr); }
    .ui-grid--6 { grid-template-columns: repeat(6, 1fr); }

    .ui-grid--auto {
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }

    .ui-grid--auto-sm {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .ui-grid--auto-lg {
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
    }


    /* ==============================================
       SECTIONS
       ============================================== */

    .ui-section {
      background: var(--color-bg-surface);
      padding: var(--space-7) var(--space-8);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      margin-bottom: var(--space-6);
    }

    .ui-section__title {
      font-size: var(--font-size-lg);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-primary);
      margin-bottom: var(--space-5);
      border-bottom: 2px solid var(--color-border-default);
      padding-bottom: var(--space-3);
    }


    /* ==============================================
       HERO SECTIONS (gradient backgrounds)
       ============================================== */

    .ui-hero {
      padding: var(--space-8);
      border-radius: var(--radius-xl);
      margin: var(--space-6) 0;
      color: var(--color-text-inverse);
    }

    .ui-hero--purple {
      background: var(--gradient-executive);
      box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
    }

    .ui-hero--green {
      background: var(--gradient-success);
      box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
    }

    .ui-hero--red {
      background: var(--gradient-danger);
      box-shadow: 0 10px 25px rgba(239, 68, 68, 0.3);
    }

    .ui-hero__title {
      font-size: var(--font-size-xl);
      font-weight: var(--font-weight-bold);
      margin-bottom: var(--space-6);
      text-align: center;
    }


    /* ==============================================
       STAT CARDS (glassmorphism on dark bg)
       ============================================== */

    .ui-stat {
      background: rgba(255, 255, 255, 0.15);
      backdrop-filter: blur(10px);
      padding: var(--space-5);
      border-radius: var(--radius-lg);
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .ui-stat__value {
      font-size: var(--font-size-2xl);
      font-weight: var(--font-weight-bold);
      margin-bottom: var(--space-1);
      line-height: var(--line-height-tight);
    }

    .ui-stat__label {
      font-size: var(--font-size-xs);
      opacity: 0.9;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }


    /* ==============================================
       METRICS
       ============================================== */

    .ui-metric {
      display: flex;
      flex-direction: column;
    }

    .ui-metric__value {
      font-size: var(--font-size-xl);
      font-weight: var(--font-weight-bold);
      color: var(--color-text-primary);
      line-height: var(--line-height-tight);
    }

    .ui-metric__label {
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
      margin-top: var(--space-1);
    }

    .ui-metric--large .ui-metric__value {
      font-size: var(--font-size-3xl);
      font-weight: var(--font-weight-extrabold);
    }

    .ui-metric--center {
      align-items: center;
      text-align: center;
    }


    /* ==============================================
       PROGRESS BARS
       ============================================== */

    .ui-progress {
      background: var(--color-border-default);
      border-radius: var(--radius-full);
      height: 8px;
      overflow: hidden;
    }

    .ui-progress--thick {
      height: 20px;
    }

    .ui-progress__bar {
      height: 100%;
      border-radius: var(--radius-full);
      transition: width var(--transition-normal);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--font-size-xs);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-inverse);
    }

    .ui-progress__bar--good {
      background: linear-gradient(90deg, var(--green-emerald-500), var(--green-emerald-600));
    }

    .ui-progress__bar--warning {
      background: linear-gradient(90deg, var(--amber-500), var(--amber-600));
    }

    .ui-progress__bar--bad {
      background: linear-gradient(90deg, var(--red-500), var(--red-600));
    }

    .ui-progress__bar--info {
      background: linear-gradient(90deg, var(--blue-500), var(--blue-600));
    }

    .ui-progress__bar--purple {
      background: linear-gradient(90deg, var(--indigo-500), var(--purple-500));
    }


    /* ==============================================
       BUTTONS
       ============================================== */

    .ui-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      border: none;
      padding: var(--space-3) var(--space-5);
      border-radius: var(--radius-md);
      cursor: pointer;
      font-size: var(--font-size-sm);
      font-weight: var(--font-weight-medium);
      transition: all var(--transition-normal);
      box-shadow: var(--shadow-sm);
    }

    .ui-btn:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .ui-btn:active {
      transform: translateY(0);
    }

    .ui-btn--primary {
      background: var(--gradient-indigo);
      color: var(--color-text-inverse);
    }

    .ui-btn--primary:hover {
      background: linear-gradient(135deg, var(--indigo-600) 0%, var(--purple-600) 100%);
    }

    .ui-btn--export {
      background: var(--gradient-success);
      color: var(--color-text-inverse);
    }

    .ui-btn--export:hover {
      background: linear-gradient(135deg, var(--green-emerald-600) 0%, var(--green-emerald-700) 100%);
    }

    .ui-btn--pdf {
      background: var(--gradient-purple);
      color: var(--color-text-inverse);
    }

    .ui-btn--pdf:hover {
      background: linear-gradient(135deg, var(--purple-600) 0%, var(--purple-700) 100%);
    }

    .ui-btn--secondary {
      background: var(--color-bg-surface);
      color: var(--color-text-secondary);
      border: 1px solid var(--color-border-default);
      box-shadow: none;
    }

    .ui-btn--secondary:hover {
      background: var(--color-bg-surface-alt);
      box-shadow: none;
      transform: none;
    }


    /* ==============================================
       MODALS
       ============================================== */

    .ui-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 1000;
      animation: fadeIn 0.2s ease-out;
    }

    .ui-modal.active {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-6);
    }

    .ui-modal__content {
      background: var(--color-bg-surface);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-xl);
      max-width: 600px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      animation: slideUp 0.2s ease-out;
    }

    .ui-modal__header {
      padding: var(--space-6) var(--space-7);
      border-bottom: 1px solid var(--color-border-default);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .ui-modal__title {
      font-size: var(--font-size-lg);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-primary);
      margin: 0;
    }

    .ui-modal__close {
      background: none;
      border: none;
      font-size: 24px;
      color: var(--color-text-disabled);
      cursor: pointer;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-sm);
      transition: all 0.2s;
    }

    .ui-modal__close:hover {
      background: var(--color-bg-surface-alt);
      color: var(--color-text-primary);
    }

    .ui-modal__body {
      padding: var(--space-7);
      color: var(--color-text-secondary);
      line-height: var(--line-height-normal);
      word-wrap: break-word;
    }


    /* ==============================================
       INFO CARDS (with colored left border)
       ============================================== */

    .ui-info-card {
      background: var(--color-bg-page);
      padding: var(--space-5);
      border-radius: var(--radius-md);
      border-left: 4px solid var(--color-info);
    }

    .ui-info-card--error {
      border-left-color: var(--color-error);
      background: var(--color-error-bg);
    }

    .ui-info-card--warning {
      border-left-color: var(--color-warning);
      background: var(--color-warning-bg);
    }

    .ui-info-card--success {
      border-left-color: var(--color-success);
      background: var(--color-success-bg);
    }

    .ui-info-card__title {
      font-size: var(--font-size-base);
      font-weight: var(--font-weight-semibold);
      color: var(--color-text-secondary);
      margin-bottom: var(--space-3);
    }

    .ui-info-card__text {
      font-size: var(--font-size-sm);
      color: var(--color-text-muted);
      margin: var(--space-1) 0;
    }


    /* ==============================================
       LINK
       ============================================== */

    .ui-link {
      color: var(--color-link);
      text-decoration: none;
      transition: color 0.2s;
    }

    .ui-link:hover {
      color: var(--color-link-hover);
      text-decoration: underline;
    }


    /* ==============================================
       TEXT UTILITIES
       ============================================== */

    .text-2xs { font-size: var(--font-size-2xs); }
    .text-xs  { font-size: var(--font-size-xs); }
    .text-sm  { font-size: var(--font-size-sm); }
    .text-base { font-size: var(--font-size-base); }
    .text-md  { font-size: var(--font-size-md); }
    .text-lg  { font-size: var(--font-size-lg); }
    .text-xl  { font-size: var(--font-size-xl); }
    .text-2xl { font-size: var(--font-size-2xl); }

    .text-primary   { color: var(--color-text-primary); }
    .text-secondary { color: var(--color-text-secondary); }
    .text-muted     { color: var(--color-text-muted); }
    .text-disabled  { color: var(--color-text-disabled); }

    .text-good    { color: var(--color-success); }
    .text-warning { color: var(--color-warning); }
    .text-bad     { color: var(--color-error); }
    .text-info    { color: var(--color-info); }

    .font-normal   { font-weight: var(--font-weight-normal); }
    .font-medium   { font-weight: var(--font-weight-medium); }
    .font-semibold { font-weight: var(--font-weight-semibold); }
    .font-bold     { font-weight: var(--font-weight-bold); }

    .text-center { text-align: center; }
    .text-right  { text-align: right; }
    .text-upper  { text-transform: uppercase; letter-spacing: 0.5px; }

    .truncate {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .line-clamp-2 {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }


    /* ==============================================
       SPACING UTILITIES
       ============================================== */

    .mt-0 { margin-top: 0; }
    .mt-1 { margin-top: var(--space-1); }
    .mt-2 { margin-top: var(--space-2); }
    .mt-3 { margin-top: var(--space-3); }
    .mt-4 { margin-top: var(--space-4); }
    .mt-5 { margin-top: var(--space-5); }
    .mt-6 { margin-top: var(--space-6); }
    .mt-7 { margin-top: var(--space-7); }
    .mt-8 { margin-top: var(--space-8); }

    .mb-0 { margin-bottom: 0; }
    .mb-1 { margin-bottom: var(--space-1); }
    .mb-2 { margin-bottom: var(--space-2); }
    .mb-3 { margin-bottom: var(--space-3); }
    .mb-4 { margin-bottom: var(--space-4); }
    .mb-5 { margin-bottom: var(--space-5); }
    .mb-6 { margin-bottom: var(--space-6); }
    .mb-7 { margin-bottom: var(--space-7); }
    .mb-8 { margin-bottom: var(--space-8); }

    .p-0 { padding: 0; }
    .p-3 { padding: var(--space-3); }
    .p-4 { padding: var(--space-4); }
    .p-5 { padding: var(--space-5); }
    .p-6 { padding: var(--space-6); }
    .p-7 { padding: var(--space-7); }

    .px-3 { padding-left: var(--space-3); padding-right: var(--space-3); }
    .px-5 { padding-left: var(--space-5); padding-right: var(--space-5); }
    .py-3 { padding-top: var(--space-3); padding-bottom: var(--space-3); }
    .py-5 { padding-top: var(--space-5); padding-bottom: var(--space-5); }

    .gap-1 { gap: var(--space-1); }
    .gap-2 { gap: var(--space-2); }
    .gap-3 { gap: var(--space-3); }
    .gap-4 { gap: var(--space-4); }
    .gap-5 { gap: var(--space-5); }
    .gap-6 { gap: var(--space-6); }
    .gap-7 { gap: var(--space-7); }
    .gap-8 { gap: var(--space-8); }


    /* ==============================================
       DISPLAY / FLEX UTILITIES
       ============================================== */

    .flex { display: flex; }
    .flex-col { flex-direction: column; }
    .flex-wrap { flex-wrap: wrap; }
    .flex-1 { flex: 1; }
    .items-center { align-items: center; }
    .items-start { align-items: flex-start; }
    .justify-center { justify-content: center; }
    .justify-between { justify-content: space-between; }
    .inline-flex { display: inline-flex; }

    .block { display: block; }
    .inline-block { display: inline-block; }
    .hidden { display: none; }


    /* ==============================================
       BORDER UTILITIES
       ============================================== */

    .border { border: 1px solid var(--color-border-default); }
    .border-b { border-bottom: 1px solid var(--color-border-default); }
    .border-t { border-top: 1px solid var(--color-border-default); }
    .rounded-sm { border-radius: var(--radius-sm); }
    .rounded-md { border-radius: var(--radius-md); }
    .rounded-lg { border-radius: var(--radius-lg); }
    .rounded-xl { border-radius: var(--radius-xl); }
    .rounded-full { border-radius: var(--radius-full); }


    /* ==============================================
       MISC UTILITIES
       ============================================== */

    .opacity-70 { opacity: 0.7; }
    .opacity-85 { opacity: 0.85; }
    .opacity-90 { opacity: 0.9; }
    .cursor-pointer { cursor: pointer; }
    .select-none { user-select: none; }
    .break-all { word-break: break-all; }
    .whitespace-nowrap { white-space: nowrap; }
    .whitespace-pre-wrap { white-space: pre-wrap; }
    .overflow-hidden { overflow: hidden; }
  `;
}

export { getUIComponents };
