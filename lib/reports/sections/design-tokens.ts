/**
 * Design Tokens — CSS Custom Properties
 * Single source of truth for colors, typography, spacing, shadows, and radii.
 * All report styles reference these tokens via var(--token-name).
 */

/**
 * Generate CSS custom properties for the design system
 * @returns CSS :root block with all design tokens
 */
function getDesignTokens(): string {
  return `
    :root {
      /* ============================================
         PRIMITIVE COLORS
         Raw palette — use semantic tokens in components
         ============================================ */

      /* Gray scale */
      --gray-50:  #f9fafb;
      --gray-100: #f3f4f6;
      --gray-200: #e5e7eb;
      --gray-300: #d1d5db;
      --gray-400: #9ca3af;
      --gray-500: #6b7280;
      --gray-600: #4b5563;
      --gray-700: #374151;
      --gray-800: #1f2937;
      --gray-900: #111827;

      /* Blue */
      --blue-50:  #eff6ff;
      --blue-100: #dbeafe;
      --blue-200: #bfdbfe;
      --blue-400: #60a5fa;
      --blue-500: #3b82f6;
      --blue-600: #2563eb;
      --blue-700: #1d4ed8;
      --blue-800: #1e40af;

      /* Green */
      --green-50:  #f0fdf4;
      --green-100: #dcfce7;
      --green-200: #bbf7d0;
      --green-400: #4ade80;
      --green-500: #22c55e;
      --green-600: #16a34a;
      --green-700: #15803d;
      --green-800: #166534;
      --green-emerald-500: #10b981;
      --green-emerald-600: #059669;
      --green-emerald-700: #047857;

      /* Red */
      --red-50:  #fef2f2;
      --red-100: #fee2e2;
      --red-200: #fecaca;
      --red-400: #f87171;
      --red-500: #ef4444;
      --red-600: #dc2626;
      --red-700: #b91c1c;
      --red-800: #991b1b;
      --red-900: #7f1d1d;

      /* Amber */
      --amber-50:  #fffbeb;
      --amber-100: #fef3c7;
      --amber-200: #fde68a;
      --amber-400: #fbbf24;
      --amber-500: #f59e0b;
      --amber-600: #d97706;
      --amber-700: #b45309;
      --amber-800: #92400e;

      /* Orange */
      --orange-50:  #fff7ed;
      --orange-100: #ffedd5;
      --orange-200: #fed7aa;
      --orange-500: #f97316;
      --orange-700: #c2410c;
      --orange-800: #9a3412;

      /* Purple */
      --purple-400: #a855f7;
      --purple-500: #8b5cf6;
      --purple-600: #7c3aed;
      --purple-700: #6d28d9;

      /* Indigo */
      --indigo-400: #818cf8;
      --indigo-500: #6366f1;
      --indigo-600: #4f46e5;
      --indigo-accent: #667eea;
      --indigo-deep: #764ba2;

      /* Pink */
      --pink-500: #ec4899;


      /* ============================================
         SEMANTIC COLORS
         Use these in components
         ============================================ */

      /* Text */
      --color-text-primary:   var(--gray-900);
      --color-text-secondary: var(--gray-700);
      --color-text-muted:     var(--gray-500);
      --color-text-disabled:  var(--gray-400);
      --color-text-inverse:   #ffffff;

      /* Backgrounds */
      --color-bg-page:        var(--gray-50);
      --color-bg-surface:     #ffffff;
      --color-bg-surface-alt: var(--gray-100);
      --color-bg-hover:       var(--gray-100);
      --color-bg-active:      var(--gray-200);

      /* Borders */
      --color-border-default: var(--gray-200);
      --color-border-subtle:  var(--gray-100);
      --color-border-strong:  var(--gray-300);

      /* Status colors */
      --color-success:     var(--green-emerald-500);
      --color-success-alt: var(--green-emerald-600);
      --color-warning:     var(--amber-500);
      --color-warning-alt: var(--amber-600);
      --color-error:       var(--red-500);
      --color-error-alt:   var(--red-600);
      --color-info:        var(--blue-500);
      --color-info-alt:    var(--blue-600);

      /* Status backgrounds (light tints) */
      --color-success-bg:     var(--green-50);
      --color-success-border: var(--green-200);
      --color-success-text:   var(--green-800);
      --color-warning-bg:     var(--amber-50);
      --color-warning-border: var(--amber-200);
      --color-warning-text:   var(--amber-800);
      --color-error-bg:       var(--red-50);
      --color-error-border:   var(--red-200);
      --color-error-text:     var(--red-800);
      --color-info-bg:        var(--blue-50);
      --color-info-border:    var(--blue-100);
      --color-info-text:      var(--blue-800);

      /* Links */
      --color-link:       var(--blue-600);
      --color-link-hover: var(--blue-700);

      /* Severity */
      --color-severity-critical-bg:     var(--red-50);
      --color-severity-critical-text:   var(--red-800);
      --color-severity-critical-border: var(--red-200);
      --color-severity-high-bg:         var(--orange-50);
      --color-severity-high-text:       var(--orange-700);
      --color-severity-high-border:     var(--orange-200);
      --color-severity-medium-bg:       var(--amber-50);
      --color-severity-medium-text:     var(--amber-700);
      --color-severity-medium-border:   var(--amber-200);
      --color-severity-low-bg:          var(--green-50);
      --color-severity-low-text:        var(--green-800);
      --color-severity-low-border:      var(--green-200);

      /* HTTP status codes */
      --color-status-2xx: var(--green-emerald-500);
      --color-status-3xx: var(--blue-500);
      --color-status-4xx: var(--amber-500);
      --color-status-5xx: var(--red-500);

      /* Scores */
      --color-score-good:    var(--green-emerald-500);
      --color-score-warning: var(--amber-500);
      --color-score-bad:     var(--red-500);
      --color-score-orange:  var(--orange-500);


      /* ============================================
         TYPOGRAPHY
         ============================================ */

      --font-family-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --font-family-mono: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', 'Courier New', monospace;

      /* Font sizes — base bumped to 15px for readability */
      --font-size-2xs: 10px;
      --font-size-xs:  11px;
      --font-size-sm:  13px;
      --font-size-base: 15px;
      --font-size-md:  16px;
      --font-size-lg:  18px;
      --font-size-xl:  22px;
      --font-size-2xl: 26px;
      --font-size-3xl: 32px;
      --font-size-4xl: 48px;

      /* Font weights */
      --font-weight-normal:    400;
      --font-weight-medium:    500;
      --font-weight-semibold:  600;
      --font-weight-bold:      700;
      --font-weight-extrabold: 800;

      /* Line heights */
      --line-height-tight:   1.25;
      --line-height-normal:  1.6;
      --line-height-relaxed: 1.75;


      /* ============================================
         SPACING
         4px base grid
         ============================================ */

      --space-0:  0px;
      --space-1:  4px;
      --space-2:  6px;
      --space-3:  8px;
      --space-4:  12px;
      --space-5:  16px;
      --space-6:  20px;
      --space-7:  24px;
      --space-8:  32px;
      --space-9:  40px;
      --space-10: 48px;
      --space-11: 56px;
      --space-12: 64px;


      /* ============================================
         BORDER RADIUS
         ============================================ */

      --radius-sm:   4px;
      --radius-md:   6px;
      --radius-lg:   8px;
      --radius-xl:   12px;
      --radius-full: 9999px;


      /* ============================================
         SHADOWS
         ============================================ */

      --shadow-sm:  0 1px 3px rgba(0, 0, 0, 0.1);
      --shadow-md:  0 4px 6px rgba(0, 0, 0, 0.1);
      --shadow-lg:  0 10px 25px rgba(0, 0, 0, 0.12);
      --shadow-xl:  0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);


      /* ============================================
         TRANSITIONS
         ============================================ */

      --transition-fast:   150ms ease;
      --transition-normal: 300ms ease;


      /* ============================================
         GRADIENTS
         ============================================ */

      --gradient-executive: linear-gradient(135deg, var(--indigo-accent) 0%, var(--indigo-deep) 100%);
      --gradient-success:   linear-gradient(135deg, var(--green-emerald-500) 0%, var(--green-emerald-600) 100%);
      --gradient-danger:    linear-gradient(135deg, var(--red-500) 0%, var(--red-600) 100%);
      --gradient-purple:    linear-gradient(135deg, var(--purple-500) 0%, var(--purple-600) 100%);
      --gradient-indigo:    linear-gradient(135deg, var(--indigo-500) 0%, var(--indigo-600) 100%);
    }
  `;
}

export { getDesignTokens };
