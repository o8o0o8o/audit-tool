### Before first run

run commands:

- yarn
- npx playwright install

### How to use

run command: `node start [your site]` where [your site] is the full address to the site you want to check

This will take a few minutes depending on the size of the site.

### How it works:

In the first step, robots.txt is analyzed to see if it exists to get the correct sitemap URLs.

### What do we check in robots.txt?

- Is the site crawlable?
- Is the sitemap present?
- Are there any errors in the rules?

In the second step, the sitemap URLs are extracted or reverted to the default sitemap URL.

### What do we check in the sitemap?

- Are there any duplicates?
- Are there any inconsistency in the trailing slashes?
- Is the origin the same?

In the third step, all URLs listed in the sitemap are crawled and checked against the sitemap data.

### What do we check in the page SEO data?

- Is the title present and unique?
- Is there a description and is it unique?
- Is there a canonical URL and does it match the location in the sitemap?
- Is there an alternative and does it match the location in the sitemap?
- Are all pages listed in the sitemap?
