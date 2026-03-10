const { SEVERITY, THRESHOLDS } = require('../../constants');

class HeadingAnalyzer {
  static async analyzeHeadings(parsedPage, url) {
    const hTags = [
      { tag: "h1", count: 0, values: [] },
      { tag: "h2", count: 0, values: [] },
      { tag: "h3", count: 0, values: [] },
      { tag: "h4", count: 0, values: [] },
      { tag: "h5", count: 0, values: [] },
      { tag: "h6", count: 0, values: [] },
    ];

    const issues = [];

    // Count and extract heading values
    for (const hTag of hTags) {
      for (const heading of parsedPage.querySelectorAll(hTag.tag)) {
        hTag.count++;
        hTag.values.push(heading.text || heading.innerText || '');
      }
    }

    // Check for issues
    for (let i = 0; i < hTags.length; i++) {
      if (hTags[i].tag === "h1" && hTags[i].count > 1) {
        issues.push({
          message: "Some pages have more than one h1 tag",
          detail: `<a href="${url}">${url}</a> has ${hTags[i].count} h1 tags`,
          severity: SEVERITY.MEDIUM
        });
      }

      if (hTags[i].tag === "h2" && hTags[i].count > THRESHOLDS.H2_COUNT) {
        issues.push({
          message: `Some pages have more than ${THRESHOLDS.H2_COUNT} h2 tags`,
          detail: `<a href="${url}">${url}</a> has ${hTags[i].count} h2 tags`,
          severity: SEVERITY.LOW
        });
      }

      if (hTags[i].count === 0 && i < 5 && hTags[i + 1].count > 0) {
        issues.push({
          message: `Some pages have incorrect h tags structure: preceding tag h${
            i + 1
          } is missing`,
          detail: `<a href="${url}">${url}</a> has incorrect h tags structure: preceding tag h${
            i + 1
          } is missing`,
          severity: SEVERITY.MEDIUM
        });
      }
    }

    return {
      h1: hTags[0].values,
      h2: hTags[1].values,
      h3: hTags[2].values,
      h4: hTags[3].values,
      h5: hTags[4].values,
      h6: hTags[5].values,
      issues
    };
  }
}

module.exports = { HeadingAnalyzer };
