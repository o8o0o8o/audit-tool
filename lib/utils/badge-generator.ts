/**
 * SVG Badge Generator
 * Generates score badges for embedding in READMEs
 */

/**
 * Generate an SVG score badge
 * @param {number} score - Score 0-100
 * @param {string} label - Badge label
 * @returns {string} SVG string
 */
function generateBadgeSVG(score: number, label: string = 'SEO Score') {
  const color = score >= 80 ? '#4c1' : score >= 60 ? '#dfb317' : score >= 40 ? '#fe7d37' : '#e05d44';
  const labelWidth = label.length * 6.5 + 10;
  const valueWidth = 44;
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${score}">
  <title>${label}: ${score}/100</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${score}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${score}</text>
  </g>
</svg>`;
}

export { generateBadgeSVG };
