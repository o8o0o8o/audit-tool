/**
 * CSS Styles for HTML Reports
 * Contains all styling for the SEO audit HTML report
 */

/**
 * Generate the CSS styles for the HTML report
 * @returns {string} CSS styles wrapped in style tags
 */
function getStyles() {
  return `
      <style>
          * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
          }

          body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
              background: #f9fafb;
              color: #111827;
              line-height: 1.6;
              padding: 20px;
          }

          .container {
              max-width: 100%;
              margin: 0 auto;
          }

          header {
              background: white;
              padding: 24px 30px;
              border-radius: 8px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              margin-bottom: 20px;
          }

          h1 {
              font-size: 28px;
              font-weight: 700;
              color: #111827;
              margin-bottom: 8px;
          }

          .subtitle {
              color: #6b7280;
              font-size: 14px;
          }

          .stats {
              display: flex;
              gap: 20px;
              margin-top: 12px;
              flex-wrap: wrap;
          }

          .stat {
              font-size: 14px;
          }

          .stat-label {
              color: #6b7280;
          }

          .stat-value {
              font-weight: 600;
              color: #111827;
          }

          .table-container {
              background: white;
              border-radius: 8px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              overflow-x: auto;
              overflow-y: visible;
              position: relative;
          }

          .table-container::after {
              content: '';
              position: absolute;
              top: 0;
              right: 0;
              bottom: 0;
              width: 30px;
              background: linear-gradient(to left, rgba(255,255,255,0.9), transparent);
              pointer-events: none;
          }

          table {
              width: 100%;
              min-width: 4500px;
              border-collapse: collapse;
              font-size: 13px;
          }

          thead {
              background: #f9fafb;
              position: sticky;
              top: 0;
              z-index: 10;
          }

          th {
              padding: 12px 8px;
              text-align: left;
              font-weight: 600;
              color: #374151;
              border-bottom: 2px solid #e5e7eb;
              white-space: nowrap;
          }

          th.url-col {
              min-width: 300px;
              max-width: 400px;
          }

          th .threshold {
              display: block;
              font-size: 11px;
              font-weight: 500;
          }

          th[title] {
              cursor: help;
          }

          th[title]:hover {
              background: #f3f4f6;
          }

          .learn-more-link {
              display: inline-block;
              margin-left: 4px;
              text-decoration: none;
              color: #3b82f6;
              font-size: 12px;
              opacity: 0.7;
              vertical-align: middle;
          }

          .learn-more-link:hover {
              opacity: 1;
              color: #1d4ed8;
              color: #9ca3af;
              margin-top: 2px;
          }

          td {
              padding: 10px 8px;
              border-bottom: 1px solid #e5e7eb;
              color: #6b7280;
          }

          tr:hover td {
              background: #f9fafb;
          }

          tr:hover td:first-child {
              background: #e5e7eb;
          }

          tr:last-child td {
              border-bottom: none;
          }

          tbody tr td:first-child {
              position: sticky;
              left: 0;
              background: white;
              z-index: 5;
              border-right: 1px solid #e5e7eb;
          }

          tbody tr:hover td:first-child {
              background: #e5e7eb;
          }

          .url-link {
              color: #2563eb;
              text-decoration: none;
              word-break: break-all;
              font-weight: 500;
          }

          .url-link:hover {
              text-decoration: underline;
          }

          .source-badge {
              display: inline-block;
              padding: 2px 6px;
              border-radius: 3px;
              font-size: 10px;
              font-weight: 600;
              text-transform: uppercase;
              margin-left: 8px;
              vertical-align: middle;
          }

          .source-sitemap {
              background: #dbeafe;
              color: #1e40af;
          }

          .source-discovered {
              background: #fef3c7;
              color: #92400e;
          }

          .status-badge {
              display: inline-block;
              padding: 3px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
              color: white;
              text-align: center;
              min-width: 40px;
          }

          .metric-cell {
              font-weight: 600;
              text-align: right;
          }

          .text-cell {
              max-width: 200px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
          }

          td[title]:not([title=""]) {
              cursor: pointer;
              position: relative;
          }

          td[title]:not([title=""]):hover {
              background: #f3f4f6;
          }

          td[title]:not([title=""])::after {
              content: 'ℹ';
              position: absolute;
              top: 2px;
              right: 2px;
              font-size: 10px;
              color: #9ca3af;
              opacity: 0.5;
              transition: opacity 0.2s;
          }

          td[title]:not([title=""]):hover::after {
              opacity: 1;
              color: #3b82f6;
          }

          /* Incoming links cell styles */
          .incoming-links-cell[data-count]:not([data-count="0"]):hover {
              background: #f3f4f6;
          }

          /* Modal styles */
          .modal-overlay {
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

          .modal-overlay.active {
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
          }

          .modal-content {
              background: white;
              border-radius: 8px;
              box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
              max-width: 600px;
              width: 100%;
              max-height: 80vh;
              overflow-y: auto;
              animation: slideUp 0.2s ease-out;
          }

          .modal-header {
              padding: 20px 24px;
              border-bottom: 1px solid #e5e7eb;
              display: flex;
              align-items: center;
              justify-content: space-between;
          }

          .modal-title {
              font-size: 18px;
              font-weight: 600;
              color: #111827;
              margin: 0;
          }

          .modal-close {
              background: none;
              border: none;
              font-size: 24px;
              color: #9ca3af;
              cursor: pointer;
              padding: 0;
              width: 32px;
              height: 32px;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 4px;
              transition: all 0.2s;
          }

          .modal-close:hover {
              background: #f3f4f6;
              color: #111827;
          }

          .modal-body {
              padding: 24px;
              color: #374151;
              line-height: 1.6;
              word-wrap: break-word;
          }

          .modal-body.with-html {
              white-space: normal;
          }

          .modal-body.with-html pre {
              white-space: pre-wrap;
              background: #f9fafb;
              padding: 12px;
              border-radius: 4px;
              font-size: 13px;
              margin: 12px 0;
          }

          .metric-section {
              margin-bottom: 16px;
              padding-bottom: 16px;
              border-bottom: 1px solid #e5e7eb;
          }

          .metric-section:last-child {
              border-bottom: none;
              margin-bottom: 0;
              padding-bottom: 0;
          }

          .metric-section h4 {
              font-size: 14px;
              font-weight: 600;
              color: #111827;
              margin-bottom: 8px;
          }

          .metric-section p {
              font-size: 13px;
              color: #6b7280;
              margin: 4px 0;
          }

          .threshold-grid {
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 8px;
              margin: 12px 0;
          }

          .threshold-item {
              padding: 8px;
              border-radius: 4px;
              font-size: 12px;
              text-align: center;
          }

          .threshold-good {
              background: #f0fdf4;
              color: #166534;
              border: 1px solid #bbf7d0;
          }

          .threshold-warning {
              background: #fffbeb;
              color: #92400e;
              border: 1px solid #fde68a;
          }

          .threshold-bad {
              background: #fef2f2;
              color: #991b1b;
              border: 1px solid #fecaca;
          }

          .source-links {
              margin-top: 12px;
          }

          .source-links h4 {
              font-size: 13px;
              font-weight: 600;
              color: #374151;
              margin-bottom: 8px;
          }

          .source-links a {
              display: block;
              color: #2563eb;
              text-decoration: none;
              font-size: 13px;
              padding: 6px 0;
              transition: color 0.2s;
          }

          .source-links a:hover {
              color: #1d4ed8;
              text-decoration: underline;
          }

          .source-links a::before {
              content: '→ ';
              margin-right: 4px;
          }

          .modal-url {
              font-size: 12px;
              color: #6b7280;
              background: #f9fafb;
              padding: 8px 12px;
              border-radius: 4px;
              word-break: break-all;
              margin-bottom: 16px;
          }

          @keyframes fadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
          }

          @keyframes slideUp {
              from {
                  opacity: 0;
                  transform: translateY(20px);
              }
              to {
                  opacity: 1;
                  transform: translateY(0);
              }
          }

          th.sortable {
              cursor: pointer;
              user-select: none;
              position: relative;
              padding-right: 20px;
          }

          th.sortable:hover {
              background: #f3f4f6;
          }

          th.sortable::after {
              content: '⇅';
              position: absolute;
              right: 8px;
              opacity: 0.3;
              font-size: 12px;
          }

          th.sortable.asc::after {
              content: '↑';
              opacity: 1;
              color: #3b82f6;
          }

          th.sortable.desc::after {
              content: '↓';
              opacity: 1;
              color: #3b82f6;
          }

          footer {
              text-align: center;
              padding: 20px;
              color: #9ca3af;
              font-size: 13px;
              margin-top: 20px;
          }

          .good { color: #10b981; }
          .warning { color: #f59e0b; }
          .bad { color: #ef4444; }
          .neutral { color: #9ca3af; }

          /* Executive Summary Styles */
          .executive-summary {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              padding: 30px;
              border-radius: 12px;
              margin: 30px 0;
              color: white;
              box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
          }

          .executive-summary h2 {
              font-size: 24px;
              font-weight: 700;
              margin-bottom: 20px;
              text-align: center;
          }

          .summary-score {
              text-align: center;
              margin-bottom: 30px;
          }

          .score-circle {
              display: inline-block;
              width: 140px;
              height: 140px;
              border-radius: 50%;
              background: rgba(255, 255, 255, 0.2);
              display: flex;
              align-items: center;
              justify-content: center;
              flex-direction: column;
              margin: 0 auto;
              backdrop-filter: blur(10px);
              border: 3px solid rgba(255, 255, 255, 0.3);
          }

          .score-number {
              font-size: 48px;
              font-weight: 800;
              line-height: 1;
          }

          .score-label {
              font-size: 12px;
              text-transform: uppercase;
              letter-spacing: 1px;
              opacity: 0.9;
              margin-top: 4px;
          }

          .summary-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              gap: 15px;
              margin-top: 20px;
          }

          .summary-card {
              background: rgba(255, 255, 255, 0.15);
              backdrop-filter: blur(10px);
              padding: 16px;
              border-radius: 8px;
              text-align: center;
              border: 1px solid rgba(255, 255, 255, 0.2);
          }

          .summary-card-value {
              font-size: 28px;
              font-weight: 700;
              margin-bottom: 4px;
          }

          .summary-card-label {
              font-size: 12px;
              opacity: 0.9;
              text-transform: uppercase;
              letter-spacing: 0.5px;
          }

          .category-scores {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
              gap: 12px;
              margin-top: 20px;
          }

          .category-score-item {
              background: rgba(255, 255, 255, 0.1);
              padding: 12px;
              border-radius: 6px;
              text-align: center;
          }

          .category-score-value {
              font-size: 24px;
              font-weight: 700;
              margin-bottom: 4px;
          }

          .category-score-label {
              font-size: 11px;
              opacity: 0.85;
          }

          /* Quick Wins & Top Issues Styles */
          .quick-wins-section {
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
              padding: 30px;
              border-radius: 12px;
              margin: 20px 0;
              color: white;
              box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
          }

          .top-issues-section {
              background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
              padding: 30px;
              border-radius: 12px;
              margin: 20px 0;
              color: white;
              box-shadow: 0 10px 25px rgba(239, 68, 68, 0.3);
          }

          .wins-issues-title {
              font-size: 22px;
              font-weight: 700;
              margin-bottom: 20px;
              text-align: center;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
          }

          .win-card, .issue-card {
              background: rgba(255, 255, 255, 0.15);
              backdrop-filter: blur(10px);
              padding: 20px;
              border-radius: 8px;
              margin-bottom: 15px;
              border: 1px solid rgba(255, 255, 255, 0.2);
              transition: transform 0.2s, box-shadow 0.2s;
          }

          .win-card:hover, .issue-card:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 12px rgba(0, 0, 0, 0.2);
          }

          .win-header, .issue-header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              margin-bottom: 12px;
              flex-wrap: wrap;
              gap: 10px;
          }

          .win-title, .issue-title {
              font-size: 16px;
              font-weight: 600;
              flex: 1;
              min-width: 200px;
          }

          .win-badges, .issue-badges {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
          }

          .win-badge, .issue-badge-item {
              padding: 4px 10px;
              border-radius: 12px;
              font-size: 11px;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              background: rgba(255, 255, 255, 0.25);
          }

          .fix-content {
              margin: 12px 0;
              padding: 12px;
              background: rgba(0, 0, 0, 0.1);
              border-radius: 6px;
              font-size: 14px;
              line-height: 1.6;
          }

          .code-example {
              background: rgba(0, 0, 0, 0.3);
              padding: 12px;
              border-radius: 6px;
              font-family: 'Courier New', monospace;
              font-size: 12px;
              margin: 8px 0;
              white-space: pre-wrap;
              word-wrap: break-word;
          }

          .affected-pages {
              font-size: 12px;
              opacity: 0.9;
              margin-top: 8px;
          }

          .resource-links {
              margin-top: 10px;
              padding-top: 10px;
              border-top: 1px solid rgba(255, 255, 255, 0.2);
          }

          .resource-link {
              display: inline-block;
              color: rgba(255, 255, 255, 0.9);
              text-decoration: none;
              font-size: 13px;
              margin-right: 15px;
              margin-top: 5px;
              transition: color 0.2s;
          }

          .resource-link:hover {
              color: white;
              text-decoration: underline;
          }

          .resource-link::before {
              content: '📚 ';
          }

          /* CSV Export Button Styles */
          .export-btn {
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 13px;
              font-weight: 500;
              transition: all 0.3s;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          }

          .export-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
              background: linear-gradient(135deg, #059669 0%, #047857 100%);
          }

          .export-btn:active {
              transform: translateY(0);
          }

          /* Charts Section Styles */
          .charts-section {
              background: white;
              border-radius: 12px;
              padding: 30px;
              margin: 30px auto;
              max-width: 100%;
              box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          }

          .charts-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
              gap: 30px;
              margin-top: 25px;
          }

          .chart-card {
              background: #f9fafb;
              border-radius: 8px;
              padding: 20px;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
          }

          .chart-card-full-width {
              grid-column: 1 / -1;
          }

          .chart-title {
              font-size: 18px;
              font-weight: 600;
              color: #1f2937;
              margin-bottom: 15px;
              text-align: center;
          }

          .chart-container {
              position: relative;
              height: 300px;
              margin: 0 auto;
          }

          #frequencyChart {
              cursor: pointer;
          }

          .no-wins-message {
              text-align: center;
              padding: 40px;
              font-size: 16px;
              opacity: 0.9;
          }

          .progress-bar-container {
              background: rgba(0, 0, 0, 0.2);
              border-radius: 10px;
              height: 20px;
              overflow: hidden;
              margin: 8px 0;
          }

          .progress-bar {
              height: 100%;
              border-radius: 10px;
              transition: width 0.3s ease;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 11px;
              font-weight: 600;
          }

          .progress-good {
              background: linear-gradient(90deg, #10b981, #059669);
          }

          .progress-warning {
              background: linear-gradient(90deg, #f59e0b, #d97706);
          }

          .progress-bad {
              background: linear-gradient(90deg, #ef4444, #dc2626);
          }

          .info-section {
              background: white;
              padding: 20px 30px;
              border-radius: 8px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              margin-bottom: 20px;
          }

          .info-section h2 {
              font-size: 18px;
              font-weight: 600;
              color: #111827;
              margin-bottom: 16px;
              border-bottom: 2px solid #e5e7eb;
              padding-bottom: 8px;
          }

          .info-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
              gap: 20px;
          }

          .info-card {
              background: #f9fafb;
              padding: 16px;
              border-radius: 6px;
              border-left: 4px solid #3b82f6;
          }

          .info-card.error {
              border-left-color: #ef4444;
              background: #fef2f2;
          }

          .info-card.warning {
              border-left-color: #f59e0b;
              background: #fffbeb;
          }

          .info-card.success {
              border-left-color: #10b981;
              background: #f0fdf4;
          }

          .info-card h3 {
              font-size: 14px;
              font-weight: 600;
              color: #374151;
              margin-bottom: 8px;
          }

          .info-card p {
              font-size: 13px;
              color: #6b7280;
              margin: 4px 0;
          }

          .info-card ul {
              margin: 8px 0;
              padding-left: 20px;
          }

          .info-card li {
              font-size: 13px;
              color: #6b7280;
              margin: 4px 0;
          }

          .info-card .label {
              font-weight: 600;
              color: #374151;
          }

          .issue-badge {
              display: inline-block;
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
              margin-right: 4px;
          }

          .issue-badge.critical {
              background: #fecaca;
              color: #991b1b;
          }

          .issue-badge.high {
              background: #fed7aa;
              color: #9a3412;
          }

          .issue-badge.medium {
              background: #fef3c7;
              color: #92400e;
          }

          .issue-badge.low {
              background: #dbeafe;
              color: #1e40af;
          }
      </style>`;
}

module.exports = { getStyles };
