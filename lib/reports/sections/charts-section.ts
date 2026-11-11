/**
 * Charts Section
 * Displays data visualization charts
 */

/**
 * Generate the charts section with canvas placeholders
 * @returns {string} HTML string for the charts section
 */
function getChartsSection() {
  return `
    <div class="charts-section">
      <h2 style="text-align: center; color: var(--color-text-primary); margin-bottom: 10px;">📊 Data Insights</h2>
      <p style="text-align: center; color: var(--color-text-muted); margin-bottom: 25px;">Visual analysis of your audit results</p>

      <div class="charts-grid">
        <div class="chart-card">
          <div class="chart-title">Issue Distribution by Severity</div>
          <div class="chart-container">
            <canvas id="issueChart"></canvas>
          </div>
        </div>

        <div class="chart-card chart-card-full-width">
          <div class="chart-title">Top 10 Issues by Frequency</div>
          <div class="chart-container">
            <canvas id="frequencyChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Performance Metrics Distribution</div>
          <div class="chart-container">
            <canvas id="performanceChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Pages by Status Code</div>
          <div class="chart-container">
            <canvas id="statusChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Word Count Distribution</div>
          <div class="chart-container">
            <canvas id="wordCountChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Indexability Breakdown</div>
          <div class="chart-container">
            <canvas id="indexabilityChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Code Coverage (JS/CSS Unused %)</div>
          <div class="chart-container">
            <canvas id="coverageChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Language Distribution</div>
          <div class="chart-container">
            <canvas id="languageChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">Internal PageRank Distribution</div>
          <div class="chart-container">
            <canvas id="pageRankChart"></canvas>
          </div>
        </div>

        <div class="chart-card">
          <div class="chart-title">CTA Coverage</div>
          <div class="chart-container">
            <canvas id="ctaChart"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
}

export { getChartsSection };
