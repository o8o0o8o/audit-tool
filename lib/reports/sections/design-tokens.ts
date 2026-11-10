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

      /* FocusReactive brand palette (focusreactive.com _variables.sass) */
      --fr-black:        #000000;
      --fr-white:        #ffffff;
      --fr-dark:         #0E0E0E;
      --fr-grey-100:     #171717;
      --fr-grey-120:     #191919;
      --fr-grey-200:     #2C2C2C;
      --fr-grey-700:     #727272;
      --fr-text-soft:    #A3A3A3;
      --fr-accent:       #00E56D;
      --fr-accent-light: #00FF79;

      /* Gray scale — inverted for the dark theme (50 = darkest surface, 900 = brightest text) */
      --gray-50:  #0E0E0E;
      --gray-100: #171717;
      --gray-200: #2C2C2C;
      --gray-300: #3A3A3A;
      --gray-400: #A3A3A3;
      --gray-500: #A3A3A3;
      --gray-600: #BDBDBD;
      --gray-700: #D4D4D4;
      --gray-800: #EDEDED;
      --gray-900: #FFFFFF;

      /* Hue scales — 50–200 are dark tints (backgrounds/borders), 400–600 are on-black fills, 700+ are light text */
      --blue-50:  #0D1626;
      --blue-100: #13213A;
      --blue-200: #1F3A66;
      --blue-400: #8AB4FF;
      --blue-500: #6EA0FF;
      --blue-600: #6EA0FF;
      --blue-700: #A8C8FF;
      --blue-800: #C4DAFF;

      --green-50:  #07190F;
      --green-100: #0B2616;
      --green-200: #134A2A;
      --green-400: #00FF79;
      --green-500: #00E56D;
      --green-600: #00E56D;
      --green-700: #5CFFA6;
      --green-800: #8FFFC2;
      --green-emerald-500: #00E56D;
      --green-emerald-600: #00C95F;
      --green-emerald-700: #00A84F;

      --red-50:  #220C0C;
      --red-100: #331212;
      --red-200: #5C1F1F;
      --red-400: #FF8A8A;
      --red-500: #FF6B6B;
      --red-600: #FF6B6B;
      --red-700: #FF9C9C;
      --red-800: #FFB4B4;
      --red-900: #FFD0D0;

      --amber-50:  #211808;
      --amber-100: #33250C;
      --amber-200: #5C4415;
      --amber-400: #FFC94D;
      --amber-500: #FFB020;
      --amber-600: #FFB020;
      --amber-700: #FFC94D;
      --amber-800: #FFD98A;

      --orange-50:  #22140A;
      --orange-100: #331E0F;
      --orange-200: #5C351A;
      --orange-500: #FF9A4D;
      --orange-700: #FFB020;
      --orange-800: #FFC266;

      --purple-400: #C4A5FF;
      --purple-500: #B794FF;
      --purple-600: #A47BFF;
      --purple-700: #8F5FFF;

      --indigo-400: #A5ADFF;
      --indigo-500: #8F98FF;
      --indigo-600: #7C86FF;
      --indigo-accent: #171717;
      --indigo-deep: #0E0E0E;

      --pink-500: #FF7AB8;


      /* ============================================
         SEMANTIC COLORS
         Use these in components
         ============================================ */

      /* Text — #727272 is decoration-only on black; secondary text uses #A3A3A3 for WCAG AA */
      --color-text-primary:   var(--fr-white);
      --color-text-secondary: #D4D4D4;
      --color-text-muted:     var(--fr-text-soft);
      --color-text-disabled:  var(--fr-text-soft);
      --color-text-inverse:   #ffffff;

      /* Backgrounds */
      --color-bg-page:        var(--fr-black);
      --color-bg-surface:     var(--fr-dark);
      --color-bg-surface-alt: var(--fr-grey-100);
      --color-bg-hover:       var(--fr-grey-120);
      --color-bg-active:      var(--fr-grey-200);

      /* Borders */
      --color-border-default: var(--fr-grey-200);
      --color-border-subtle:  var(--fr-grey-100);
      --color-border-strong:  var(--fr-grey-700);

      /* Brand accent */
      --color-accent:       var(--fr-accent);
      --color-accent-light: var(--fr-accent-light);
      --color-on-accent:    var(--fr-black);

      /* Status colors */
      --color-success:     var(--green-emerald-500);
      --color-success-alt: var(--green-emerald-600);
      --color-warning:     var(--amber-500);
      --color-warning-alt: var(--amber-600);
      --color-error:       var(--red-500);
      --color-error-alt:   var(--red-600);
      --color-info:        var(--blue-500);
      --color-info-alt:    var(--blue-600);

      /* Status backgrounds (dark tints) */
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
      --color-link:       var(--fr-accent);
      --color-link-hover: var(--fr-accent-light);

      /* Severity */
      --color-severity-critical-bg:     var(--red-50);
      --color-severity-critical-text:   #FF6B6B;
      --color-severity-critical-border: var(--red-200);
      --color-severity-high-bg:         var(--orange-50);
      --color-severity-high-text:       #FFB020;
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

      --font-family-sans: 'Inter', Helvetica, sans-serif;
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
      --radius-lg:   12px;
      --radius-xl:   16px;
      --radius-full: 9999px;
      --radius-card: 16px;
      --radius-pill: 100px;


      /* ============================================
         SHADOWS
         ============================================ */

      --shadow-sm:  none;
      --shadow-md:  none;
      --shadow-lg:  0 10px 25px rgba(0, 0, 0, 0.6);
      --shadow-xl:  0 20px 40px rgba(0, 0, 0, 0.7);


      /* ============================================
         TRANSITIONS
         ============================================ */

      --transition-fast:   150ms ease;
      --transition-normal: 300ms ease;


      /* ============================================
         GRADIENTS
         ============================================ */

      --gradient-executive: linear-gradient(var(--fr-dark), var(--fr-dark));
      --gradient-success:   linear-gradient(135deg, #0B2616 0%, #134A2A 100%);
      --gradient-danger:    linear-gradient(135deg, #2A0E0E 0%, #3A1212 100%);
      --gradient-purple:    linear-gradient(var(--fr-grey-200), var(--fr-grey-200));
      --gradient-indigo:    linear-gradient(var(--fr-grey-100), var(--fr-grey-100));
    }
  `;
}

export { getDesignTokens };
