/**
 * GitHub Actions Workflow Generator
 * Generates a CI/CD workflow for automated SEO audits
 */

function generateWorkflow(origin, options = {}) {
  const schedule = options.schedule || '0 6 * * 1'; // Default: Monday 6am
  const threshold = options.threshold || 70;
  const nodeVersion = options.nodeVersion || '18';

  return `name: SEO Audit

on:
  schedule:
    - cron: '${schedule}'
  workflow_dispatch:
    inputs:
      url:
        description: 'URL to audit'
        default: '${origin}'
        required: true

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '${nodeVersion}'

      - name: Install dependencies
        run: |
          npm ci
          npx playwright install --with-deps chromium

      - name: Run SEO Audit
        run: node start.js --origin=\${{ github.event.inputs.url || '${origin}' }} --ci=${threshold} --json > audit-result.json
        continue-on-error: true

      - name: Upload Report
        uses: actions/upload-artifact@v4
        with:
          name: seo-report
          path: audit-results/
          retention-days: 30

      - name: Check Score Threshold
        run: |
          SCORE=$(node -e "const r=require('./audit-result.json'); console.log(r.score)")
          echo "Score: $SCORE / Threshold: ${threshold}"
          if [ "$SCORE" -lt "${threshold}" ]; then
            echo "::error::SEO score $SCORE is below threshold ${threshold}"
            exit 1
          fi
`;
}

module.exports = { generateWorkflow };
