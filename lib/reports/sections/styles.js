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
              scroll-behavior: smooth;
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
              overflow-y: auto;
              max-height: 80vh;
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

          /* Score donut ring */
          .score-ring {
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              border-radius: 50%;
              --score: 0;
              --color: #ef4444;
              background: conic-gradient(
                  var(--color) calc(var(--score) * 3.6deg),
                  rgba(255,255,255,0.15) 0
              );
              mask: radial-gradient(farthest-side, transparent calc(100% - 6px), black calc(100% - 5px));
              -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 6px), black calc(100% - 5px));
              animation: scoreRingFill 1s ease-out forwards;
          }

          @keyframes scoreRingFill {
              from { --score: 0; }
          }

          /* Score count-up animation */
          @keyframes scoreCountUp {
              from { opacity: 0; transform: scale(0.5); }
              to { opacity: 1; transform: scale(1); }
          }

          .score-circle {
              animation: scoreCountUp 0.6s ease-out;
          }

          @keyframes scorePulse {
              0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.4); }
              50% { box-shadow: 0 0 0 12px rgba(255,255,255,0); }
          }

          .score-circle.animated {
              animation: scoreCountUp 0.6s ease-out, scorePulse 1.5s ease-in-out 0.6s;
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

          /* Save to PDF Button */
          .pdf-btn {
              background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
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

          .pdf-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
              background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
          }

          .pdf-btn:active {
              transform: translateY(0);
          }

          /* Dark Mode */
          /* Sticky navigation sidebar */
          .report-nav {
              position: fixed;
              left: 0;
              top: 50%;
              transform: translateY(-50%);
              z-index: 800;
              display: flex;
              flex-direction: column;
              gap: 2px;
              padding: 8px 0;
              background: white;
              border-radius: 0 8px 8px 0;
              box-shadow: 2px 0 8px rgba(0,0,0,0.1);
          }


          .report-nav a {
              display: flex;
              align-items: center;
              padding: 8px 12px;
              text-decoration: none;
              color: #6b7280;
              font-size: 18px;
              transition: all 0.2s;
              position: relative;
          }

          .report-nav a:hover {
              background: #f3f4f6;
              color: #111827;
          }


          .report-nav a .nav-label {
              display: none;
              position: absolute;
              left: 100%;
              top: 50%;
              transform: translateY(-50%);
              margin-left: 8px;
              padding: 4px 10px;
              background: #111827;
              color: white;
              border-radius: 4px;
              font-size: 12px;
              white-space: nowrap;
              pointer-events: none;
          }

          .report-nav a:hover .nav-label {
              display: block;
          }

          .report-nav a.active {
              color: #3b82f6;
              background: #eff6ff;
          }


          /* Back to top button */
          .back-to-top {
              position: fixed;
              bottom: 30px;
              right: 30px;
              z-index: 900;
              background: linear-gradient(135deg, #6366f1, #4f46e5);
              color: white;
              border: none;
              width: 48px;
              height: 48px;
              border-radius: 50%;
              cursor: pointer;
              font-size: 22px;
              display: none;
              align-items: center;
              justify-content: center;
              box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
              transition: all 0.3s;
          }

          .back-to-top.visible {
              display: flex;
          }

          .back-to-top:hover {
              transform: scale(1.1);
          }

          /* Collapsible sections */
          .section-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              cursor: pointer;
              user-select: none;
          }

          .section-toggle {
              background: none;
              border: none;
              font-size: 20px;
              cursor: pointer;
              color: inherit;
              opacity: 0.6;
              transition: transform 0.3s;
              padding: 4px 8px;
          }

          .section-toggle.collapsed {
              transform: rotate(-90deg);
          }

          .section-content {
              overflow: hidden;
              transition: max-height 0.3s ease;
          }

          .section-content.collapsed {
              max-height: 0 !important;
              overflow: hidden;
          }

          /* Column picker */
          .column-picker-btn {
              background: #f3f4f6;
              border: 1px solid #d1d5db;
              border-radius: 6px;
              padding: 8px 12px;
              cursor: pointer;
              font-size: 14px;
              display: flex;
              align-items: center;
              gap: 4px;
          }

          .column-picker-btn:hover {
              background: #e5e7eb;
          }

          .column-picker-dropdown {
              display: none;
              position: absolute;
              top: 100%;
              right: 0;
              background: white;
              border: 1px solid #d1d5db;
              border-radius: 8px;
              box-shadow: 0 10px 25px rgba(0,0,0,0.15);
              padding: 12px;
              z-index: 100;
              max-height: 400px;
              overflow-y: auto;
              min-width: 220px;
          }


          .column-picker-dropdown.visible {
              display: block;
          }

          .column-picker-dropdown label {
              display: flex;
              align-items: center;
              gap: 8px;
              padding: 4px 0;
              font-size: 13px;
              cursor: pointer;
              color: #374151;
          }


          .column-picker-dropdown .picker-group {
              font-weight: 600;
              font-size: 11px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              color: #9ca3af;
              margin-top: 8px;
              margin-bottom: 4px;
              padding-top: 8px;
              border-top: 1px solid #e5e7eb;
          }

          .column-picker-dropdown .picker-group:first-child {
              margin-top: 0;
              padding-top: 0;
              border-top: none;
          }

          /* Global search */
          .global-search {
              position: fixed;
              top: 20px;
              right: 70px;
              z-index: 900;
              display: none;
          }

          .global-search.visible {
              display: flex;
          }

          .global-search input {
              padding: 8px 14px;
              border: 2px solid #3b82f6;
              border-radius: 8px;
              font-size: 14px;
              width: 260px;
              outline: none;
              box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
          }


          .global-search .search-count {
              position: absolute;
              right: 12px;
              top: 50%;
              transform: translateY(-50%);
              font-size: 11px;
              color: #9ca3af;
          }

          /* Keyboard shortcut hint */
          .keyboard-hint {
              position: fixed;
              bottom: 30px;
              left: 50%;
              transform: translateX(-50%);
              background: rgba(0,0,0,0.8);
              color: white;
              padding: 8px 16px;
              border-radius: 8px;
              font-size: 12px;
              z-index: 1000;
              opacity: 0;
              transition: opacity 0.3s;
              pointer-events: none;
          }

          .keyboard-hint.visible {
              opacity: 1;
          }

          .keyboard-hint kbd {
              background: rgba(255,255,255,0.2);
              padding: 2px 6px;
              border-radius: 3px;
              margin: 0 2px;
              font-family: monospace;
          }

          /* Search highlight */
          mark.search-highlight {
              background: #fde68a;
              color: #92400e;
              padding: 0 2px;
              border-radius: 2px;
          }


          /* Page detail modal enhancements */
          .page-detail-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 12px;
              margin-top: 16px;
          }

          .page-detail-card {
              background: #f9fafb;
              padding: 12px;
              border-radius: 6px;
              border-left: 3px solid #3b82f6;
          }


          .page-detail-card .detail-label {
              font-size: 11px;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              color: #9ca3af;
              margin-bottom: 4px;
          }

          .page-detail-card .detail-value {
              font-size: 18px;
              font-weight: 700;
              color: #111827;
          }


          .page-detail-card .detail-status {
              font-size: 12px;
              margin-top: 2px;
          }

          /* Section tabs */
          .section-tabs {
              display: flex;
              gap: 0;
              background: white;
              border-radius: 8px 8px 0 0;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
              margin: 20px 0 0;
              overflow-x: auto;
              position: sticky;
              top: 0;
              z-index: 50;
          }


          .section-tab {
              padding: 12px 20px;
              border: none;
              background: transparent;
              color: #6b7280;
              font-size: 13px;
              font-weight: 500;
              cursor: pointer;
              border-bottom: 3px solid transparent;
              white-space: nowrap;
              transition: all 0.2s;
          }

          .section-tab:hover {
              color: #111827;
              background: #f9fafb;
          }


          .section-tab.active {
              color: #3b82f6;
              border-bottom-color: #3b82f6;
              font-weight: 600;
          }

          /* Pagination */
          .pagination {
              display: flex;
              justify-content: center;
              align-items: center;
              gap: 8px;
              margin-top: 16px;
              padding: 12px;
          }

          .pagination button {
              padding: 6px 12px;
              border: 1px solid #d1d5db;
              border-radius: 6px;
              background: white;
              color: #374151;
              font-size: 13px;
              cursor: pointer;
              transition: all 0.2s;
          }

          .pagination button:hover:not(:disabled) {
              background: #f3f4f6;
          }

          .pagination button:disabled {
              opacity: 0.4;
              cursor: default;
          }

          .pagination button.active {
              background: #3b82f6;
              color: white;
              border-color: #3b82f6;
          }

          .pagination .page-info {
              font-size: 13px;
              color: #6b7280;
              margin: 0 8px;
          }



          /* Row selection */
          tr.selected td {
              background: #eff6ff !important;
          }


          .selection-bar {
              position: fixed;
              bottom: 0;
              left: 0;
              right: 0;
              background: #1f2937;
              color: white;
              padding: 12px 24px;
              display: none;
              align-items: center;
              justify-content: space-between;
              z-index: 900;
              box-shadow: 0 -4px 12px rgba(0,0,0,0.2);
          }

          .selection-bar.visible {
              display: flex;
          }

          .selection-bar button {
              padding: 6px 14px;
              border: 1px solid #4b5563;
              border-radius: 6px;
              background: transparent;
              color: white;
              cursor: pointer;
              font-size: 13px;
              margin-left: 8px;
          }

          .selection-bar button:hover {
              background: #374151;
          }

          /* URL group header row */
          .url-group-row td {
              background: #f3f4f6 !important;
              font-weight: 600;
              color: #374151;
              padding: 8px 12px !important;
              border-bottom: 2px solid #d1d5db;
              cursor: pointer;
          }


          .url-group-row td .group-count {
              font-weight: 400;
              color: #9ca3af;
              margin-left: 8px;
              font-size: 12px;
          }

          /* Filter preset buttons */
          .filter-presets {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
              margin-bottom: 12px;
          }

          .filter-preset-btn {
              padding: 5px 12px;
              border: 1px solid #d1d5db;
              border-radius: 20px;
              background: white;
              color: #374151;
              font-size: 12px;
              cursor: pointer;
              transition: all 0.2s;
          }

          .filter-preset-btn:hover {
              background: #f3f4f6;
          }

          .filter-preset-btn.active {
              background: #3b82f6;
              color: white;
              border-color: #3b82f6;
          }



          /* Row hover tooltip */
          .row-tooltip {
              position: fixed;
              z-index: 100;
              background: #1f2937;
              color: #e5e7eb;
              padding: 10px 14px;
              border-radius: 8px;
              font-size: 12px;
              line-height: 1.6;
              box-shadow: 0 8px 24px rgba(0,0,0,0.2);
              pointer-events: none;
              opacity: 0;
              transition: opacity 0.15s;
              max-width: 320px;
              white-space: nowrap;
          }

          .row-tooltip.visible {
              opacity: 1;
          }

          .row-tooltip .tt-label {
              color: #9ca3af;
              margin-right: 6px;
          }

          .row-tooltip .tt-good { color: #34d399; }
          .row-tooltip .tt-warn { color: #fbbf24; }
          .row-tooltip .tt-bad { color: #f87171; }

          /* Horizontal scroll indicator for table */
          .table-scroll-wrapper {
              position: relative;
          }

          .scroll-indicator {
              position: absolute;
              top: 0;
              bottom: 0;
              width: 40px;
              pointer-events: none;
              z-index: 10;
              opacity: 0;
              transition: opacity 0.3s;
          }

          .scroll-indicator.right {
              right: 0;
              background: linear-gradient(to left, rgba(0,0,0,0.08), transparent);
          }

          .scroll-indicator.left {
              left: 0;
              background: linear-gradient(to right, rgba(0,0,0,0.08), transparent);
          }

          .scroll-indicator.visible {
              opacity: 1;
          }



          /* Floating action button */
          .fab-container {
              position: fixed;
              bottom: 30px;
              right: 90px;
              z-index: 900;
          }

          .fab-toggle {
              width: 48px;
              height: 48px;
              border-radius: 50%;
              background: linear-gradient(135deg, #6366f1, #4f46e5);
              color: white;
              border: none;
              font-size: 22px;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: center;
              box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
              transition: all 0.3s;
          }

          .fab-toggle:hover {
              transform: scale(1.1);
          }

          .fab-toggle.open {
              transform: rotate(45deg);
          }

          .fab-menu {
              position: absolute;
              bottom: 58px;
              right: 0;
              display: none;
              flex-direction: column;
              gap: 6px;
              max-height: 70vh;
              overflow-y: auto;
              padding: 8px 0;
          }

          .fab-menu.visible {
              display: flex;
          }

          .fab-item {
              padding: 8px 14px;
              background: white;
              border: 1px solid #e5e7eb;
              border-radius: 8px;
              font-size: 13px;
              cursor: pointer;
              white-space: nowrap;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              transition: all 0.2s;
              text-align: left;
          }

          .fab-item:hover {
              background: #f3f4f6;
              transform: translateX(-4px);
          }

          .fab-divider {
              height: 1px;
              background: #e5e7eb;
              margin: 2px 0;
          }


          .fab-label {
              font-size: 10px;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              color: #9ca3af;
              padding: 4px 14px 0;
          }



          /* Copy toast notification */
          .copy-toast {
              position: fixed;
              bottom: 80px;
              left: 50%;
              transform: translateX(-50%) translateY(20px);
              background: #111827;
              color: white;
              padding: 8px 16px;
              border-radius: 8px;
              font-size: 13px;
              z-index: 1000;
              opacity: 0;
              transition: all 0.3s;
              pointer-events: none;
          }


          .copy-toast.visible {
              opacity: 1;
              transform: translateX(-50%) translateY(0);
          }

          /* Responsive sidebar */
          @media (max-width: 768px) {
              .report-nav {
                  display: none;
              }

              .section-tabs {
                  font-size: 11px;
              }

              .section-tab {
                  padding: 8px 12px;
              }

              .fab-container {
                  right: 20px;
                  bottom: 20px;
              }


              .global-search {
                  right: 52px;
                  top: 10px;
              }

              .global-search input {
                  width: 180px;
                  font-size: 12px;
              }

              header {
                  padding: 16px;
              }

              h1 {
                  font-size: 20px;
              }

              .executive-summary {
                  padding: 16px;
              }

              .score-circle {
                  width: 100px;
                  height: 100px;
              }

              .score-number {
                  font-size: 36px;
              }

              .summary-grid {
                  grid-template-columns: repeat(3, 1fr);
                  gap: 8px;
              }

              .charts-grid {
                  grid-template-columns: 1fr;
              }

              .export-section {
                  display: none;
              }
          }

          /* Performance budget indicator */
          .perf-budget {
              display: inline-flex;
              align-items: center;
              gap: 3px;
              font-size: 11px;
          }

          .perf-budget-bar {
              width: 40px;
              height: 6px;
              background: #e5e7eb;
              border-radius: 3px;
              overflow: hidden;
              display: inline-block;
          }

          .perf-budget-fill {
              height: 100%;
              border-radius: 3px;
              transition: width 0.3s;
          }

          /* Reading progress bar */
          .reading-progress {
              position: fixed;
              top: 0;
              left: 0;
              height: 3px;
              background: linear-gradient(90deg, #3b82f6, #8b5cf6);
              z-index: 9999;
              transition: width 0.1s linear;
              width: 0%;
          }

          /* Skip to content link */
          .skip-link {
              position: absolute;
              top: -40px;
              left: 0;
              background: #3b82f6;
              color: white;
              padding: 8px 16px;
              z-index: 10000;
              border-radius: 0 0 8px 0;
              font-size: 14px;
              transition: top 0.3s;
          }

          .skip-link:focus {
              top: 0;
          }

          /* Reduced motion */
          @media (prefers-reduced-motion: reduce) {
              *, *::before, *::after {
                  animation-duration: 0.01ms !important;
                  transition-duration: 0.01ms !important;
                  scroll-behavior: auto !important;
              }
          }



          /* Focus ring for keyboard navigation */
          :focus-visible {
              outline: 3px solid #3b82f6;
              outline-offset: 2px;
          }





          /* Insight Badges */
          .insight-badge {
              display: inline-block;
              padding: 4px 10px;
              border-radius: 12px;
              font-size: 12px;
              font-weight: 500;
          }
          .insight-badge.warn {
              background: rgba(251, 191, 36, 0.2);
              color: #fbbf24;
          }
          .insight-badge.info {
              background: rgba(96, 165, 250, 0.2);
              color: #93c5fd;
          }

          /* Summary Card Urgency Hint */
          .summary-card-hint {
              font-size: 10px;
              margin-top: 4px;
              opacity: 0.8;
              font-weight: 600;
              letter-spacing: 0.5px;
              text-transform: uppercase;
          }

          /* Section Divider */
          .section-divider {
              height: 1px;
              background: linear-gradient(90deg, transparent, #d1d5db, transparent);
              margin: 30px 0;
          }

          /* Issue Education (Why This Matters) */
          .issue-education {
              margin-top: 10px;
              border-left: 3px solid #3b82f6;
              padding-left: 12px;
          }

          .education-toggle {
              cursor: pointer;
              font-size: 13px;
              font-weight: 600;
              color: #3b82f6;
              user-select: none;
              list-style: none;
          }

          .education-toggle::-webkit-details-marker { display: none; }
          .education-toggle::before {
              content: '▶ ';
              font-size: 10px;
              transition: transform 0.2s;
              display: inline-block;
          }
          details[open] > .education-toggle::before {
              transform: rotate(90deg);
          }

          .education-text {
              margin: 8px 0 4px;
              font-size: 13px;
              line-height: 1.5;
              opacity: 0.9;
          }

          .education-link {
              font-size: 12px;
              color: #3b82f6;
              text-decoration: none;
          }
          .education-link:hover {
              text-decoration: underline;
          }


          /* Sticky Table Header */
          .table-container thead th {
              position: sticky;
              top: 0;
              z-index: 10;
              background: #f9fafb;
              box-shadow: 0 2px 4px rgba(0,0,0,0.08);
          }


          /* Table Zebra Striping */
          #pagesTable tbody tr:nth-child(even) {
              background: rgba(0,0,0,0.02);
          }

          /* Table Row Hover */
          #pagesTable tbody tr:hover {
              background: rgba(59, 130, 246, 0.06) !important;
          }

          /* Keyboard Focus Row */
          #pagesTable tbody tr.keyboard-focus {
              outline: 2px solid #3b82f6;
              outline-offset: -2px;
              background: rgba(59, 130, 246, 0.08) !important;
          }

          /* Smooth Anchor Scroll Offset */
          [id] {
              scroll-margin-top: 20px;
          }

          /* Score Badge (for inline use) */
          .score-badge {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              width: 36px;
              height: 36px;
              border-radius: 50%;
              font-weight: 700;
              font-size: 12px;
              color: white;
          }
          .score-badge.good { background: #10b981; }
          .score-badge.warning { background: #f59e0b; }
          .score-badge.bad { background: #ef4444; }

          /* Issue Count Badges on Section Tabs */
          .section-tab .tab-badge {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              min-width: 20px;
              height: 20px;
              padding: 0 6px;
              border-radius: 10px;
              background: #ef4444;
              color: white;
              font-size: 11px;
              font-weight: 600;
              margin-left: 6px;
              vertical-align: middle;
          }

          .section-tab .tab-badge.zero {
              background: #10b981;
          }

          /* Expandable Examples in Issue Cards */
          .affected-pages {
              font-size: 12px;
              margin-top: 8px;
          }

          .issue-example-item {
              padding: 6px 10px;
              margin: 3px 0;
              background: rgba(0, 0, 0, 0.05);
              border-radius: 4px;
              border-left: 3px solid rgba(255, 255, 255, 0.3);
              word-break: break-word;
              line-height: 1.5;
          }

          .issue-example-item a {
              color: #60a5fa;
              text-decoration: underline;
              word-break: break-all;
          }

          .issue-example-item a:hover {
              color: #93c5fd;
          }

          .issue-toggle-btn {
              background: none;
              border: none;
              color: #60a5fa;
              font-size: 12px;
              cursor: pointer;
              padding: 4px 0;
              text-decoration: underline;
              margin-top: 4px;
          }

          .issue-toggle-btn:hover {
              color: #93c5fd;
          }

          .show-more-btn {
              background: none;
              border: none;
              color: #3b82f6;
              font-size: 12px;
              cursor: pointer;
              padding: 4px 0;
              text-decoration: underline;
          }

          /* Table Filter Count */
          #filterCount {
              font-size: 13px;
              color: #6b7280;
              margin-left: 12px;
              font-style: italic;
          }

          /* Loading Skeleton */
          .skeleton {
              background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
              background-size: 200% 100%;
              animation: skeleton-shimmer 1.5s infinite;
              border-radius: 4px;
          }
          @keyframes skeleton-shimmer {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
          }

          /* Empty State */
          .empty-state {
              text-align: center;
              padding: 40px 20px;
              color: #9ca3af;
          }
          .empty-state-icon {
              font-size: 48px;
              margin-bottom: 12px;
              opacity: 0.5;
          }
          .empty-state-text {
              font-size: 16px;
              margin-bottom: 4px;
          }
          .empty-state-subtext {
              font-size: 13px;
              opacity: 0.7;
          }

          /* Animated Score Counter */
          .score-number {
              transition: color 0.3s;
          }

          /* Deep Link Hash Highlight */
          :target {
              animation: highlight-pulse 1s ease-out;
          }
          @keyframes highlight-pulse {
              0% { outline: 3px solid #3b82f6; outline-offset: 4px; }
              100% { outline: 3px solid transparent; outline-offset: 4px; }
          }

          /* Table Column Resize Handle */
          th.sortable {
              position: relative;
          }

          /* Tooltip for Category Scores */
          .category-tooltip {
              position: absolute;
              background: #1f2937;
              color: white;
              padding: 8px 12px;
              border-radius: 6px;
              font-size: 12px;
              max-width: 250px;
              z-index: 100;
              pointer-events: none;
              opacity: 0;
              transition: opacity 0.2s;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2);
          }
          .category-tooltip.visible { opacity: 1; }

          /* Notification Toast (improved) */
          .notification-toast {
              position: fixed;
              bottom: 30px;
              left: 50%;
              transform: translateX(-50%) translateY(20px);
              background: #1f2937;
              color: white;
              padding: 12px 24px;
              border-radius: 8px;
              font-size: 14px;
              z-index: 2000;
              opacity: 0;
              transition: opacity 0.3s, transform 0.3s;
              box-shadow: 0 4px 12px rgba(0,0,0,0.3);
              pointer-events: none;
          }
          .notification-toast.visible {
              opacity: 1;
              transform: translateX(-50%) translateY(0);
          }

          /* Timeline/Phase Visualization */
          .phase-timeline {
              display: flex;
              gap: 0;
              margin: 16px 0;
              height: 8px;
              border-radius: 4px;
              overflow: hidden;
          }
          .phase-bar {
              height: 100%;
              transition: width 0.3s;
              position: relative;
          }
          .phase-bar:hover::after {
              content: attr(data-label);
              position: absolute;
              bottom: 14px;
              left: 50%;
              transform: translateX(-50%);
              background: #1f2937;
              color: white;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 11px;
              white-space: nowrap;
          }

          /* Performance Budget Bars */
          .perf-budget-row {
              display: flex;
              align-items: center;
              gap: 12px;
              padding: 8px 0;
              border-bottom: 1px solid #f3f4f6;
          }
          .perf-budget-label {
              width: 80px;
              font-size: 13px;
              font-weight: 600;
              color: #374151;
          }
          .perf-budget-bar-container {
              flex: 1;
              height: 12px;
              background: #f3f4f6;
              border-radius: 6px;
              overflow: hidden;
              position: relative;
          }
          .perf-budget-bar {
              height: 100%;
              border-radius: 6px;
              transition: width 0.6s ease-out;
          }
          .perf-budget-bar.good { background: linear-gradient(90deg, #10b981, #34d399); }
          .perf-budget-bar.warning { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
          .perf-budget-bar.bad { background: linear-gradient(90deg, #ef4444, #f87171); }
          .perf-budget-threshold {
              position: absolute;
              top: 0;
              bottom: 0;
              width: 2px;
              background: #1f2937;
              opacity: 0.5;
          }
          .perf-budget-value {
              width: 80px;
              text-align: right;
              font-size: 13px;
              font-weight: 600;
          }


          /* Responsive table improvements */
          @media (max-width: 768px) {
              body { padding: 10px; }
              header { padding: 16px; }
              h1 { font-size: 22px; }
              .stats { flex-direction: column; gap: 8px; }
              .summary-grid { grid-template-columns: repeat(2, 1fr); }
              .executive-summary { padding: 20px; }
              .report-nav { display: none; }
              .fab-container { bottom: 15px; right: 15px; }
              .section-tabs { flex-wrap: wrap; }
              .section-tab { font-size: 12px; padding: 6px 10px; }
              .filter-presets { flex-wrap: wrap; gap: 4px; }
              .filter-preset-btn { font-size: 11px; padding: 4px 8px; }
              .export-section { display: none; }
              .win-card, .issue-card { padding: 12px; }
              .global-search input { width: 250px; }
          }

          @media (max-width: 480px) {
              .summary-grid { grid-template-columns: 1fr; }
              .charts-grid { grid-template-columns: 1fr !important; }
              .fab-menu { right: 0; }
          }

          /* Print / PDF Export Styles */
          @media print {
              @page {
                  size: A4 landscape;
                  margin: 12mm;
              }

              * {
                  -webkit-print-color-adjust: exact !important;
                  print-color-adjust: exact !important;
                  color-adjust: exact !important;
              }

              body {
                  background: white !important;
                  padding: 0 !important;
                  font-size: 11px !important;
              }

              .container {
                  max-width: 100% !important;
              }

              /* Hide all interactive / navigation elements */
              .export-btn,
              .pdf-btn,
              #issueFilterModal,
              .modal-overlay,
              .modal-content,
              .issue-toggle-btn,
              .pagination-controls,
              .table-pagination,
              .section-toggle,
              .fab-container,
              .back-to-top,
              .report-nav,
              .column-picker-btn,
              .learn-more-link,
              .resource-link,
              .show-more-btn,
              .section-tabs,
              .global-search,
              .keyboard-hint,
              .reading-progress,
              .skip-link,
              .selection-bar,
              th.sortable::after,
              .export-section {
                  display: none !important;
              }

              /* Expand all collapsed content */
              .section-content,
              .section-content.collapsed {
                  max-height: none !important;
                  overflow: visible !important;
              }

              /* Show all hidden examples */
              [id^="issue-more-"] {
                  display: block !important;
              }

              /* Expand all details elements */
              details[open] > summary ~ *,
              details > *:not(summary) {
                  display: block !important;
              }

              /* === Header === */
              header {
                  page-break-after: avoid;
                  margin-bottom: 10px !important;
                  padding: 15px 20px !important;
                  box-shadow: none !important;
              }

              h1 { font-size: 22px !important; }
              h2 { font-size: 16px !important; }
              h3 { font-size: 13px !important; }

              /* === Executive Summary — flatten gradient for reliable PDF rendering === */
              .executive-summary {
                  background: #5b4fa0 !important;
                  color: white !important;
                  padding: 20px !important;
                  margin: 10px 0 !important;
                  page-break-inside: avoid;
                  border-radius: 8px !important;
                  box-shadow: none !important;
              }

              .score-circle {
                  width: 90px !important;
                  height: 90px !important;
                  background: rgba(255, 255, 255, 0.2) !important;
                  backdrop-filter: none !important;
                  -webkit-backdrop-filter: none !important;
              }

              .score-number {
                  font-size: 32px !important;
              }

              .score-ring {
                  display: none !important;
              }

              .summary-grid {
                  grid-template-columns: repeat(4, 1fr) !important;
                  gap: 10px !important;
              }

              .summary-card {
                  background: rgba(255, 255, 255, 0.15) !important;
                  backdrop-filter: none !important;
                  -webkit-backdrop-filter: none !important;
                  padding: 10px !important;
              }

              /* Category score items — ensure visible in print */
              .category-score-item {
                  page-break-inside: avoid;
              }

              .progress-bar {
                  -webkit-print-color-adjust: exact !important;
                  print-color-adjust: exact !important;
              }

              /* === Charts — use static images, hide canvases === */
              .charts-section {
                  padding: 15px !important;
                  margin: 10px 0 !important;
                  box-shadow: none !important;
              }

              .charts-grid {
                  grid-template-columns: repeat(2, 1fr) !important;
                  gap: 15px !important;
              }

              .chart-card {
                  page-break-inside: avoid;
                  box-shadow: none !important;
                  border: 1px solid #e5e7eb !important;
              }

              .chart-container {
                  height: auto !important;
                  min-height: 0 !important;
                  overflow: visible !important;
              }

              /* Static chart images rendered from canvas */
              .pdf-chart-img {
                  max-height: 250px !important;
                  width: 100% !important;
                  object-fit: contain;
              }

              /* Hide canvas when image replacement is present */
              canvas {
                  display: none !important;
              }

              /* === Quick Wins & Issues === */
              .quick-wins-section,
              .top-issues-section {
                  padding: 15px !important;
                  margin: 10px 0 !important;
                  box-shadow: none !important;
              }

              .win-card,
              .issue-card {
                  padding: 10px !important;
                  margin-bottom: 8px !important;
                  page-break-inside: avoid;
                  box-shadow: none !important;
                  border: 1px solid #e5e7eb !important;
              }

              /* Status and severity badges */
              .status-badge,
              .source-badge,
              .issue-badge,
              .severity-critical,
              .severity-high,
              .severity-medium,
              .severity-low {
                  -webkit-print-color-adjust: exact !important;
                  print-color-adjust: exact !important;
              }

              /* === Tables === */
              .table-container {
                  overflow: visible !important;
                  box-shadow: none !important;
                  border: 1px solid #e5e7eb !important;
              }

              .table-container::after {
                  display: none !important;
              }

              table {
                  min-width: 100% !important;
                  font-size: 8px !important;
                  border-collapse: collapse !important;
              }

              th, td {
                  padding: 4px 3px !important;
                  border: 1px solid #e5e7eb !important;
              }

              th {
                  background: #f3f4f6 !important;
                  font-weight: 600 !important;
              }

              thead {
                  display: table-header-group;
              }

              tbody tr {
                  page-break-inside: avoid;
              }

              tbody tr td:first-child {
                  position: static !important;
                  border-right: 1px solid #e5e7eb !important;
              }

              th.url-col {
                  min-width: 120px !important;
                  max-width: 180px !important;
              }

              .url-link {
                  font-size: 7px !important;
                  word-break: break-all;
              }

              /* === Info sections / Config === */
              .info-section {
                  padding: 15px !important;
                  margin-bottom: 10px !important;
                  page-break-inside: avoid;
                  box-shadow: none !important;
              }

              .info-card {
                  box-shadow: none !important;
                  border: 1px solid #e5e7eb !important;
              }

              /* === Page break control === */
              .charts-section,
              .quick-wins-section,
              .top-issues-section {
                  page-break-before: always;
              }

              #pages-table {
                  page-break-before: always;
              }

              .info-section,
              .table-container {
                  page-break-before: auto;
              }

              /* === Footer === */
              footer {
                  margin-top: 10px !important;
                  padding: 10px !important;
                  font-size: 10px !important;
                  page-break-before: avoid;
              }

              footer::after {
                  content: " | Printed: " attr(data-print-date);
              }

              /* === Info grid === */
              .info-grid {
                  grid-template-columns: repeat(2, 1fr) !important;
                  gap: 10px !important;
              }

              /* Remove all animations */
              *, *::before, *::after {
                  animation: none !important;
                  transition: none !important;
              }

              /* Prevent links from adding URL text after them */
              a[href]::after {
                  content: none !important;
              }
          }
      </style>`;
}

module.exports = { getStyles };
