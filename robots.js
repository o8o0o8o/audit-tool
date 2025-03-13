const { parse } = require("node-html-parser");
const fs = require("fs");
const { chromium } = require("playwright");
const { generateHTML } = require("./generateHTML");

class SEOData {
  #results;
  #proceed;
  #perf;

  constructor(origin, proceed, perf) {
    if (proceed === "--proceed") {
      this.#proceed = proceed;
    }

    if (perf === "--no-perf") {
      this.#perf = false;
    } else {
      this.#perf = true;
    }

    this.origin = origin.replace(/\s/g, "").replace(/\/$/, "");

    this.domainName = this.origin.replace("https://", "");

    this.file = `SEOAnalysis__${this.domainName}.json`;

    this.#results = {
      robots: { sitemaps: [], "user-agent": {} },
      sitemaps: { urls: {}, total: 0 },
      pageData: {
        pages: {},
        processedPages: new Set(),
        totalWithoutError: 0,
        totalWithError: 0,
        byError: {},
      },
      analysis: { overall: new Set(), details: new Set() },
    };

    this.networkConditions = {
      slow3g: {
        download: ((500 * 1000) / 8) * 0.8,
        upload: ((500 * 1000) / 8) * 0.8,
        latency: 400 * 5,
        name: "slow3g",
      },
      fast3g: {
        download: ((1.6 * 1000 * 1000) / 8) * 0.9,
        upload: ((750 * 1000) / 8) * 0.9,
        latency: 150 * 3.75,
        name: "fast3g",
      },
      slow4g: {
        download: ((1.6 * 1000 * 1000) / 8) * 1.5,
        upload: ((750 * 1000) / 8) * 1.5,
        latency: 150,
        name: "slow4g",
      },
      normal: {
        noThrottle: true,
        name: "normal",
      },
    };

    this.cpuConditions = {
      normal: {
        noThrottle: true,
        name: "normal",
      },
    };
  }

  async #checkImages(parsedPage, page, saveError) {
    const images = [];

    for (const image of parsedPage.querySelectorAll("img")) {
      const alt = image.attributes.alt;

      if (alt) {
        images.push(alt);
      }
    }

    return images;
  }

  async #checkHeadings(parsedPage, page, saveError) {
    const hTags = [
      { tag: "h1", count: 0, values: [] },
      { tag: "h2", count: 0, values: [] },
      { tag: "h3", count: 0, values: [] },
      { tag: "h4", count: 0, values: [] },
      { tag: "h5", count: 0, values: [] },
      { tag: "h6", count: 0, values: [] },
    ];

    for (const hTag of hTags) {
      for (const heading of parsedPage.querySelectorAll(hTag.tag)) {
        hTag.count++;

        hTag.values.push(heading.innerText);
      }
    }

    for (let i = 0; i < hTags.length; i++) {
      if (hTags[i].tag === "h1" && hTags[i].count > 1) {
        saveError(
          "Some pages have more than one h1 tag",
          `<a href="${page}">${page}</a> has more than one h1 tag`
        );
      }

      if (hTags[i].tag === "h2" && hTags[i].count > 10) {
        saveError(
          "Some pages have more than 10 h2 tags",
          `<a href="${page}">${page}</a> has more than ten h2 tags`
        );
      }

      if (hTags[i].count === 0 && i < 5 && hTags[i + 1].count > 0) {
        saveError(
          `Some pages have incorrect h tags structure: preceding tag h${
            i + 1
          } is missing`,
          `<a href="${page}">${page}</a> has incorrect h tags structure: preceding tag h${
            i + 1
          } is missing`
        );
      }
    }

    return hTags;
  }

  async #withTimeout(promise, timeoutMs, message = "Observer timeout") {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), timeoutMs)
      ),
    ]);
  }

  saveError(generalError, detailedError) {
    this.#results.analysis.overall.add(generalError);

    if (detailedError) {
      if (!this.#results.analysis.details[generalError]) {
        this.#results.analysis.details[generalError] = [];
      }

      this.#results.analysis.details[generalError].push(detailedError);
    }
  }

  async #restoreProgress() {
    try {
      const seoData = await JSON.parse(fs.readFileSync(this.file, "utf-8"));

      this.#results = {
        ...seoData,
        pageData: {
          ...seoData.pageData,
          processedPages: new Set(seoData.pageData.processedPages),
        },
        analysis: {
          ...seoData.analysis,
          overall: new Set(seoData.analysis.overall),
        },
      };
    } catch (error) {
      console.log(error);
    }
  }

  saveData() {
    fs.writeFileSync(
      this.file,
      JSON.stringify({
        ...this.#results,
        analysis: {
          ...this.#results.analysis,
          overall: Array.from(this.#results.analysis.overall),
          details: Object.entries(this.#results.analysis.details).reduce(
            (prev, curr) => ({
              ...prev,
              [curr[0]]: Array.from(new Set(curr[1])).sort(),
            }),
            {}
          ),
        },
        pageData: {
          ...this.#results.pageData,
          processedPages: Array.from(this.#results.pageData.processedPages),
        },
      })
    );
  }

  async #analyzeRobotsTxt() {
    try {
      const robotsResponse = await fetch(this.origin + "/robots.txt");

      if (robotsResponse.status === 200) {
        const robots = await robotsResponse.text();

        if (robots.length) {
          let currentUserAgent = "";

          for (const str of robots.split("\n")) {
            const data = str.split(": ");
            const field = data[0].toLocaleLowerCase();
            const value = data[1];

            if (field === "sitemap") {
              this.#results.robots.sitemaps.push(value);
            }

            if (field === "user-agent") {
              currentUserAgent = value;

              if (!this.#results.robots["user-agent"][value]) {
                this.#results.robots["user-agent"][value] = {
                  allow: [],
                  disallow: [],
                };
              }
            }

            if (field === "disallow") {
              this.#results.robots["user-agent"][
                currentUserAgent
              ].disallow.push(value);

              if (value === "/") {
                this.saveError(
                  `Some user-agents are not allowed to crawl by robots.txt`,
                  `user-agent ${currentUserAgent} is blocked by robots.txt`
                );
              }
            }

            if (field === "allow") {
              this.#results.robots["user-agent"][currentUserAgent].allow.push(
                value
              );
            }
          }
        } else {
          this.saveError("robots.txt is empty");
        }
      } else {
        this.saveError("Error fetching robots.txt");
      }

      if (!this.#results.robots.sitemaps.length) {
        const message = "No sitemap in robots.txt";

        this.saveError(message);

        const sitemapUrl = this.origin + "/sitemap.xml";

        console.log(message + " fallback to default sitemap url " + sitemapUrl);

        this.#results.sitemaps = { [sitemapUrl]: {} };
      }

      for (const [key, value] of Object.entries(
        this.#results.robots["user-agent"]
      )) {
        if (!value.allow.length && !value.disallow.length) {
          this.saveError(
            `Some user-agents have no rules in robots.txt`,
            `Empty ruleset for user-agent ${key} in robots.txt`
          );
        }
      }
    } catch (error) {
      const message = `Error during processing robots.txt ${error.name} ${error.message} ${error.cause}`;

      this.saveError(message);

      console.log(message);
    }
  }

  #getURLsFromSitemap({ urls, unique, processedUrls, currentSitemap }) {
    for (const site of urls) {
      const processedData = {
        loc: site.querySelector("loc")?.innerText,
        lastmod: site.querySelector("lastmod")?.innerText,
        changefreq: site.querySelector("changefreq")?.innerText,
        priority: site.querySelector("priority")?.innerText,
        alternates: {},
      };

      unique.add(processedData.loc);

      for (const alternate of site.querySelectorAll("xhtml:link")) {
        if (alternate.attributes.rel === "alternate") {
          processedData.alternates[alternate.attributes.href] = {
            hreflang: alternate.attributes.hreflang,
            href: alternate.attributes.href,
          };
        }
      }

      processedUrls[processedData.loc] = processedData;
    }
    const locs = Object.keys(processedUrls);

    if (locs.length >= 50000) {
      this.saveError("Sitemap is reached the limit 50000 " + currentSitemap);
    }

    if (unique.size !== locs.length) {
      for (const site of locs) {
        const count = locs.reduce((acc, curr) => {
          if (curr === site) {
            return acc + 1;
          }
          return acc;
        }, 0);

        if (count > 1) {
          this.saveError(
            "There are duplications in sitemap " + currentSitemap,
            `Duplicate url: ${key} in sitemap: ${currentSitemap}`
          );
        }
      }
    }

    const withTrailingSlash = [];
    const withoutTrailingLSlash = [];

    for (const site of unique) {
      if (!site.startsWith(this.origin)) {
        this.saveError(`Incorrect origin ${site} in sitemap ${currentSitemap}`);
      }

      if (site.endsWith("/")) {
        withTrailingSlash.push(site);
      } else {
        withoutTrailingLSlash.push(site);
      }
    }

    if (withTrailingSlash.length && withoutTrailingLSlash.length) {
      this.saveError(
        `Trailing slash inconsistencies in sitemap ${currentSitemap}: withTrailingSlash = ${withTrailingSlash.length}, withoutTrailingLSlash = ${withoutTrailingLSlash.length}`
      );
    }

    this.#results.sitemaps[currentSitemap] = {
      total: locs.length,
      totalUnique: unique.size,
      urls: processedUrls,
    };

    this.#results.sitemaps.urls = {
      ...this.#results.sitemaps.urls,
      ...processedUrls,
    };
    this.#results.sitemaps.total += locs.length;
  }

  async #analyzeSitemaps() {
    for (const sitemapUrl of this.#results.robots.sitemaps) {
      try {
        const sitemapResponse = await fetch(sitemapUrl);
        const sitemap = await sitemapResponse.text();
        const parsedSitemap = parse(sitemap);
        const unique = new Set();
        const processedUrls = {};
        const urls = parsedSitemap.querySelectorAll("url");

        if (urls.length) {
          this.#getURLsFromSitemap({
            urls,
            unique,
            processedUrls,
            currentSitemap: sitemapUrl,
          });
        } else {
          for (const sitemap of parsedSitemap.querySelectorAll("sitemap")) {
            const sitemapPage = sitemap.querySelector("loc")?.innerText;
            const sitemapPageResponse = await fetch(sitemapPage);
            const sitemapPageText = await sitemapPageResponse.text();
            const parsedSitemapPage = parse(sitemapPageText);

            this.#getURLsFromSitemap({
              urls: parsedSitemapPage.querySelectorAll("url"),
              unique,
              processedUrls,
              currentSitemap: sitemapPage,
            });
          }
        }
      } catch (error) {
        const message = `Error during processing sitemap ${sitemapUrl} ${error.name} ${error.message} ${error.cause}`;

        this.saveError(message);

        console.log(message);
      }
    }
  }

  async #basicTest(page, network, cpu, url) {
    console.time("basicTest");

    if (this.#perf) {
      const session = await page.context().newCDPSession(page);

      // Enable performance metrics collection
      await session.send("Performance.enable");

      // Apply CPU throttling if needed
      if (!cpu.noThrottle && cpu.rate) {
        await session.send("Emulation.setCPUThrottlingRate", {
          rate: cpu.rate,
        });
      }

      // Apply network throttling if needed
      if (!network.noThrottle) {
        await session.send("Network.enable");

        await session.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: network.download,
          uploadThroughput: network.upload,
          latency: network.latency,
        });
      }
    }

    // Navigate to the page
    const response = await page.goto(url);

    const status = response?.status();

    let vitals = {};

    if (this.#perf) {
      if (status == 200) {
        console.log(`Collect vitals: ${status} ${url}`);

        // Collect performance metrics
        vitals = await this.#collectVitals(page);
      } else {
        console.log(`Error: ${status} ${url}`);
      }
    }

    console.timeEnd("basicTest");

    return { ...vitals, status };
  }

  async #collectVitals(page) {
    console.time("collectVitals");

    let CLS = 0;

    const LCP = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const observer = new PerformanceObserver(async (list) => {
            const entries = list.getEntries();
            const lcp = entries.at(-1);

            observer.disconnect();

            resolve(Number(lcp?.startTime || 0).toFixed(2));

            CLS = await page.evaluate(
              () =>
                new Promise((resolve) => {
                  const observer = new PerformanceObserver((list) => {
                    let total = 0;
                    for (const entry of list.getEntries()) {
                      total += entry.value;
                    }
                    observer.disconnect();

                    resolve(+total.toPrecision(2));
                  });

                  observer.observe({ type: "layout-shift", buffered: true });

                  setTimeout(() => {
                    observer.disconnect();

                    resolve(0);
                  }, 10000);
                })
            );
          });
          observer.observe({
            type: "largest-contentful-paint",
            buffered: true,
          });
        })
    );

    const TTFB = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const observer = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            if (entries.length > 0) {
              const navigationEntry = entries[0];
              const ttfb =
                navigationEntry.responseStart - navigationEntry.fetchStart;

              observer.disconnect();

              resolve(ttfb.toFixed(2));
            }
          });
          observer.observe({ type: "navigation", buffered: true });
        })
    );

    console.timeEnd("collectVitals");

    console.log({ CLS, TTFB, LCP });

    return { CLS, TTFB, LCP };
  }

  async #crawlPages({ pagesToCrawl, collectedURLs, uniquePages, addMissing }) {
    try {
      const browser = await chromium.launch();
      const context = await browser.newContext({
        viewport: { width: 414, height: 896 },
        // deviceScaleFactor: 2, // not working?
      });

      const alternatesErrors = [];
      const uniqueTitles = new Set();
      const uniqueDescriptions = new Set();
      const failedPages = [];

      let isMultiLang = false;

      const META_TAGS = [
        "description",
        "keywords",
        "robots",
        "og:type",
        "og:url",
        "og:title",
        "og:description",
        "og:site_name",
        "og:image",
        "twitter:site",
        "twitter:creator",
        "twitter:title",
        "twitter:description",
        "twitter:card",
        "twitter:widgets:new-embed-design",
        "twitter:image:src",
      ];

      for (let i = 0; i <= pagesToCrawl.length - 1; i++) {
        const url = pagesToCrawl[i];

        if (this.#results.pageData.processedPages.has(url)) {
          continue;
        }

        this.saveData();

        console.log("Pages left " + (pagesToCrawl.length - i));

        let page = undefined;

        const chromePage = await context.newPage();

        // chromePage.setDefaultTimeout(30000);

        try {
          let messageDetailed = url;

          page = await this.#withTimeout(
            this.#basicTest(
              chromePage,
              this.networkConditions.slow4g,
              this.cpuConditions.normal,
              url
            )
              .then(async (data) => ({ ...data, url }))
              .catch((error) => {
                const messageOverall = `${error.name} ${error.message} ${error.cause}`;
                messageDetailed = `${url} ${messageOverall}`;

                this.saveError(messageOverall, messageDetailed);

                console.log(messageDetailed);

                this.#results.pageData.totalWithError += 1;

                if (!this.#results.pageData.byError.crashed) {
                  this.#results.pageData.byError.crashed = [];
                  this.#results.pageData.byError.totalCrashed = 0;
                }

                this.#results.pageData.byError.crashed.push(url);
                this.#results.pageData.byError.totalCrashed += 1;

                // TODO: add retry mechanism
                this.#results.pageData.processedPages.add(url);
              }),
            30000,
            "Core Web Vitals test failed. Page failed to load " +
              messageDetailed
          );
        } catch (error) {
          console.log(error);

          process.exit(1);
        }

        if (page) {
          const { url, status, CLS, TTFB, LCP } = page;

          this.#results.pageData.pages[url] = {};

          const pageData = this.#results.pageData.pages[url];

          pageData.status = status;
          pageData.url = url;
          pageData.TTFB = TTFB;
          pageData.CLS = CLS;
          pageData.LCP = LCP;

          if (status !== 200) {
            this.#results.pageData.totalWithError += 1;

            if (!this.#results.pageData.byError[status]) {
              this.#results.pageData.byError[status] = [];
              this.#results.pageData.byError[`total${status}`] = 0;
            }

            this.#results.pageData.byError[status].push(url);
            this.#results.pageData.byError[`total${status}`] += 1;

            this.#results.pageData.processedPages.add(url);

            this.saveData();

            continue;
          } else {
            this.#results.pageData.totalWithoutError += 1;
          }

          const pageContent = await chromePage.content();
          const parsedPage = parse(pageContent);
          const folder = this.origin.replaceAll("/", "|").replaceAll(".", ":");

          try {
            fs.mkdirSync(folder);
          } catch (error) {}

          fs.writeFileSync(
            `${folder}/${url.replaceAll("/", "|").replaceAll(".", ":")}.html`,
            pageContent
          );

          const links = [];

          for (const link of parsedPage.querySelectorAll("a")) {
            const href = link.attributes.href;
            const text = link.innerText || link.attributes["aria-label"];

            if (href?.startsWith(url)) {
              if (addMissing) {
                if (!collectedURLs.has(url)) {
                  pagesToCrawl.push(url);

                  collectedURLs.add(url);

                  uniquePages.add(url);
                }
              } else if (!uniquePages.has(url)) {
                collectedURLs.add(url);
              }
            }

            links.push({ text, href });

            if (!text) {
              this.saveError(
                `Some pages have links without any text`,
                `The page <a href="${url}">${url}</a> has a link without text "${href}"`
              );
            }
          }

          pageData.links = links;

          const title = await chromePage.evaluate(
            () => document.querySelector("title")?.innerText
          );

          pageData.headings = await this.#checkHeadings(
            parsedPage,
            url,
            ((a, b) => this.saveError(a, b)).bind(this)
          );

          pageData.images = await this.#checkImages(parsedPage);

          if (TTFB > 800) {
            this.saveError(
              `Some pages have TTFB more than 800`,
              `The page <a href="${url}">${url}</a> has TTFB more than 800 ${TTFB}`
            );

            console.log("TTFB: " + TTFB, url);
          }

          if (CLS > 0.1) {
            this.saveError(
              `Some pages CLS more than 0.1`,
              `The page <a href="${url}">${url}</a> has CLS more than 0.1 ${CLS}`
            );

            console.log("CLS: " + CLS, url);
          }

          if (LCP > 2500) {
            this.saveError(
              `Some pages LCP more than 2500`,
              `The page <a href="${url}">${url}</a> has LCP more than 2500 ${LCP}`
            );

            console.log("LCP: " + LCP, url);
          }

          if (!title) {
            this.saveError(
              `Title is missing`,
              `Title is missing for this page <a href="${url}">${url}</a>`
            );
          } else {
            pageData.title = title;

            if (uniqueTitles.has(title)) {
              this.saveError(
                `Some pages have identical titles`,
                `Title "${title}" is duplicated for this page <a href="${url}">${url}</a>`
              );
            }

            uniqueTitles.add(title);
          }

          pageData.meta = [];

          for (const metaTag of await chromePage.evaluate(() =>
            Array.from(document.querySelectorAll("meta")).map((meta) => ({
              name: meta.name || meta.getAttribute("property"),
              content: meta.content,
            }))
          )) {
            const name = metaTag.name;
            const content = metaTag.content;

            for (const tag of META_TAGS) {
              if (name === tag) {
                pageData.meta.push({ [tag]: content });

                if (name === "description" && uniqueDescriptions.has(content)) {
                  this.saveError(
                    `Some pages have identical descriptions`,
                    `Description "${content}" is duplicated for this page <a href="${url}">${url}</a>`
                  );
                }

                uniqueDescriptions.add(content);
              }
            }
          }

          if (pageData?.meta?.length !== META_TAGS.length) {
            for (const tag of META_TAGS) {
              if (
                !pageData?.meta?.some((pageMeta) =>
                  Object.keys(pageMeta).some((pageTag) => pageTag === tag)
                )
              ) {
                this.saveError(
                  `Some meta tags are missing`,
                  `Meta tag ${tag} is missing for this page <a href="${url}">${url}</a>`
                );
              }
            }
          }

          for (const link of await chromePage.evaluate(() =>
            Array.from(document.querySelectorAll("link")).map((link) => ({
              rel: link.rel,
              hrefLang: link.hrefLang,
              href: link.href,
            }))
          )) {
            const rel = link.rel;

            if (rel === "canonical") {
              pageData.canonical = link.href;
            }

            if (rel === "alternate") {
              isMultiLang = true;

              if (!pageData.alternates) {
                pageData.alternates = [];
              }

              pageData.alternates.push({
                hreflang: link.hrefLang,
                href: link.href,
              });
            }
          }

          if (!pageData.canonical) {
            this.saveError(
              `Canonicals are not set for some pages`,
              `Canonical link is missing for this page <a href="${url}">${url}</a>`
            );
          }

          if (!pageData.alternates) {
            this.saveError(
              `Alternates are not set for some pages`,
              `Alternates links are missing for this page <a href="${url}">${url}</a>`
            );
          } else {
            for (const alternate of pageData.alternates) {
              const count = pageData.alternates.reduce((acc, cur) => {
                if (cur.href === alternate.href) {
                  return (acc += 1);
                }

                return acc;
              }, 0);

              if (count > 1) {
                this.saveError(
                  `Some alternates are duplicated in head links`,
                  `Alternate ${alternate.href} is duplicated for this page <a href="${url}">${url}</a>`
                );
              }
            }
          }

          const matchingCanonical =
            this.#results.sitemaps.urls[pageData.canonical] ||
            this.#results.sitemaps.urls[`${this.origin}pageData.canonical`];

          if (matchingCanonical) {
            if (matchingCanonical.alternates && pageData.alternates) {
              for (const pageAlternate of pageData.alternates) {
                if (matchingCanonical.alternates[pageAlternate.href]) {
                } else {
                  this.saveError(
                    `Some alternates from sitemap don't match alternates form pages`,
                    `Alternate ${pageAlternate.href} has no match in sitemap for loc ${pageData.canonical} for this page <a href="${url}">${url}</a>`
                  );
                }
              }
            }

            if (Array.isArray(pageData.alternates)) {
              for (const pageAlternate of pageData.alternates) {
                const sitemapAlternate =
                  matchingCanonical.alternates[pageAlternate.href];

                if (sitemapAlternate) {
                  if (sitemapAlternate.hreflang !== pageAlternate.hreflang) {
                    this.saveError(
                      `Some alternate hreflangs from sitemap don't match alternate hreflangs from pages`,
                      `Alternate hreflangs ${pageAlternate.hreflang} doesn't match sitemap hreflang ${sitemapAlternate.hreflang} for loc ${pageData.canonical} for this page <a href="${url}">${url}</a>`
                    );
                  }
                } else {
                  this.saveError(
                    `Some alternate hrefs from sitemap don't match alternates from pages`,
                    `Alternate href ${pageAlternate.href} has no match in sitemap for canonical ${pageData.canonical} for this page <a href="${url}">${url}</a>`
                  );
                }
              }
            }
          } else {
            this.saveError(
              `Some loc and canonical don't match`,
              `No matching loc corresponding canonical ${pageData.canonical} is found for this page <a href="${url}">${url}</a>`
            );
          }

          this.#results.pageData.processedPages.add(url);

          this.saveData();
        } else {
          console.log(`Page ${url} was not loaded`);

          this.saveError(
            `Some pages were not loaded.`,
            `Page <a href="${url}">${url}</a> was not loaded`
          );

          failedPages.push(url);
        }

        await chromePage.close();
      }

      await browser.close();

      return { alternatesErrors, isMultiLang, failedPages };
    } catch (error) {
      console.log(error);
    }
  }

  async #analyzePages() {
    const uniquePages = new Set(Object.keys(this.#results.sitemaps.urls));
    const collectedURLs = new Set();
    const pagesToCrawl = Array.from(uniquePages);

    console.log("Crawling pages from sitemap...");

    const crawledData = await this.#crawlPages({
      pagesToCrawl,
      collectedURLs,
      uniquePages,
    });

    let alternatesErrors = crawledData.alternatesErrors;
    let isMultiLang = crawledData.isMultiLang;
    let failedPages = crawledData.failedPages;

    if (collectedURLs.size) {
      this.saveError(`Some URLs are not listed in sitemap`);

      console.log("Crawling pages that are missing in sitemap...");

      const crawledData = await this.#crawlPages({
        pagesToCrawl: Array.from(collectedURLs),
        collectedURLs,
        uniquePages,
        addMissing: true,
      });

      alternatesErrors = crawledData.alternatesErrors;
      isMultiLang = isMultiLang || crawledData.isMultiLang;
      failedPages = [...crawledData.failedPages, ...failedPages];
    }

    if (failedPages.length) {
      fs.writeFileSync("failedPages.json", JSON.stringify(failedPages));
    }

    if (isMultiLang && alternatesErrors.length) {
      for (const alternatesError of alternatesErrors) {
        this.saveError(
          `Alternates are not set for some pages`,
          alternatesError
        );
      }
    }

    this.#results.pageData.total = uniquePages.size;
    this.#results.pageData.isMultiLang = isMultiLang;
  }

  async audit() {
    try {
      if (this.#proceed) {
        console.log("Proceeding...");

        await this.#restoreProgress();

        await this.#analyzePages();
      } else {
        await this.#analyzeRobotsTxt();

        await this.#analyzeSitemaps();

        await this.#analyzePages();
      }
    } catch (error) {
      this.saveError(error);
    }

    this.saveData();
  }
}

async function audit() {
  try {
    const origin = process.argv[2];
    const proceed = process.argv[3];
    const perf = process.argv[4];
    const seo = new SEOData(origin, proceed, perf);

    await seo.audit(origin, proceed, perf);
    generateHTML(seo.file, seo.domainName);
  } catch (error) {
    console.log(error);
  }
}

audit();
