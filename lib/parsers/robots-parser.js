/**
 * Robots.txt Parser
 * Fetches and parses robots.txt files according to the robots exclusion protocol
 */

const { SEVERITY } = require('../constants');

class RobotsParser {
  /**
   * Fetch and parse robots.txt from a given origin
   * @param {string} origin - Website origin URL
   * @returns {Promise<object>} Parsed robots data and any errors found
   */
  static async parseRobotsTxt(origin) {
    const result = {
      sitemaps: [],
      userAgents: {},
      errors: [], // Array of { message, detail, severity }
    };

    try {
      console.log("Analyzing robots.txt...");
      const robotsResponse = await fetch(origin + "/robots.txt");

      if (robotsResponse.status === 200) {
        const robotsContent = await robotsResponse.text();

        if (robotsContent.length) {
          this.parseRobotsContent(robotsContent, result);
        } else {
          result.errors.push({
            message: "robots.txt is empty",
            detail: null,
            severity: SEVERITY.HIGH
          });
        }
      } else {
        result.errors.push({
          message: "Error fetching robots.txt",
          detail: null,
          severity: SEVERITY.CRITICAL
        });
      }

      // Check for sitemap and add fallback if needed
      this.checkSitemaps(origin, result);

      // Validate user-agent rules
      this.validateUserAgentRules(result);

    } catch (error) {
      const message = `Error during processing robots.txt ${error.name} ${error.message} ${error.cause || ''}`;
      result.errors.push({
        message,
        detail: null,
        severity: SEVERITY.HIGH
      });
      console.log(message);
    }

    return result;
  }

  /**
   * Parse robots.txt content into structured data
   * @param {string} content - robots.txt content
   * @param {object} result - Result object to populate
   */
  static parseRobotsContent(content, result) {
    let currentUserAgent = "";

    for (const line of content.split("\n")) {
      const data = line.split(": ");
      const field = data[0].toLowerCase().trim();
      const value = data[1]?.trim();

      if (field === "sitemap") {
        if (value) {
          result.sitemaps.push(value);
        }
      }

      if (field === "user-agent") {
        currentUserAgent = value || "";

        if (!result.userAgents[currentUserAgent]) {
          result.userAgents[currentUserAgent] = {
            allow: [],
            disallow: [],
          };
        }
      }

      if (field === "disallow" && currentUserAgent) {
        result.userAgents[currentUserAgent].disallow.push(value || "");

        // Check for blocking all crawlers
        if (value === "/") {
          result.errors.push({
            message: "Some user-agents are not allowed to crawl by robots.txt",
            detail: `user-agent ${currentUserAgent} is blocked by robots.txt`,
            severity: SEVERITY.CRITICAL
          });
        }
      }

      if (field === "allow" && currentUserAgent) {
        result.userAgents[currentUserAgent].allow.push(value || "");
      }
    }
  }

  /**
   * Check for sitemaps and add fallback if needed
   * @param {string} origin - Website origin
   * @param {object} result - Result object to update
   */
  static checkSitemaps(origin, result) {
    if (!result.sitemaps.length) {
      const message = "No sitemap in robots.txt";
      result.errors.push({
        message,
        detail: null,
        severity: SEVERITY.MEDIUM
      });

      const sitemapUrl = origin + "/sitemap.xml";
      console.log(message + " fallback to default sitemap url " + sitemapUrl);

      // Add default sitemap URL to sitemaps array
      result.sitemaps.push(sitemapUrl);
    }
  }

  /**
   * Validate user-agent rules
   * @param {object} result - Result object to check
   */
  static validateUserAgentRules(result) {
    for (const [userAgent, rules] of Object.entries(result.userAgents)) {
      if (!rules.allow.length && !rules.disallow.length) {
        result.errors.push({
          message: "Some user-agents have no rules in robots.txt",
          detail: `Empty ruleset for user-agent ${userAgent} in robots.txt`,
          severity: SEVERITY.LOW
        });
      }
    }
  }
}

module.exports = { RobotsParser };

// CLI testing
if (require.main === module) {
  (async () => {
    const testUrl = process.argv[2] || 'https://example.com';
    console.log(`Testing RobotsParser with ${testUrl}\n`);

    const result = await RobotsParser.parseRobotsTxt(testUrl);

    console.log('\n📊 Results:');
    console.log('Sitemaps found:', result.sitemaps.length);
    result.sitemaps.forEach(s => console.log('  -', s));

    console.log('\nUser-Agents:', Object.keys(result.userAgents).length);
    Object.entries(result.userAgents).forEach(([ua, rules]) => {
      console.log(`  - ${ua}: ${rules.allow.length} allow, ${rules.disallow.length} disallow`);
    });

    console.log('\nErrors/Warnings:', result.errors.length);
    result.errors.forEach(err => {
      console.log(`  - [${err.severity}] ${err.message}`);
      if (err.detail) console.log(`    ${err.detail}`);
    });
  })();
}
