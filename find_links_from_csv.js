/**
 * find_links_from_csv.js - Direct URL Builder & Verifier
 *
 * Constructs comic URLs directly and verifies they exist
 * Tries multiple URL variations (with/without "The", different formats)
 *
 * Usage:
 *   node find_links_from_csv.js input.csv output.csv
 */

const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// URL and series pattern caches
let urlCache = {};
let seriesPatternCache = {};

// ----- CONFIG -----
const SITES = [
  {
    key: 'readcomiconline',
    name: 'ReadComicOnline',
    buildUrl: (series, year, issue) => {
      const slug = series.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '');
      if (year) {
        return `https://readcomiconline.li/Comic/${slug}-${year}/Issue-${issue}`;
      } else {
        return `https://readcomiconline.li/Comic/${slug}/Issue-${issue}`;
      }
    },
    variations: true,
    tryWithoutYear: true // Try URLs without year
  },
  {
    key: 'viewcomics',
    name: 'ViewComics',
    buildUrl: (series, year, issue) => {
      const slug = series.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '');
      if (year) {
        return `https://viewcomics.me/comic/${slug}-${year}/${issue}`;
      } else {
        return `https://viewcomics.me/comic/${slug}/${issue}`;
      }
    },
    variations: true,
    tryWithoutYear: true
  },
  {
    key: 'readallcomics',
    name: 'ReadAllComics',
    buildUrl: (series, year, issue) => {
      const slug = series.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/g, '');
      const paddedIssue = issue.padStart(3, '0');
      if (year) {
        return `https://readallcomics.com/${slug}-${year}-${paddedIssue}`;
      } else {
        return `https://readallcomics.com/${slug}-${paddedIssue}`;
      }
    },
    variations: true,
    tryWithoutYear: true
  }
];

const DEFAULT_TIMEOUT = 30000; // Increased timeout
const GOOGLE_TIMEOUT = 60000; // Separate timeout for Google searches

/** Parse comic title */
function parseComicTitle(title) {
  // Remove anything in square brackets (like [A Story], [Part 1], etc.)
  let cleanTitle = title.replace(/\[.*?\]/g, '').trim();
  
  // Pattern: "Series Name (Year) #Issue"
  const match = cleanTitle.match(/^(.+?)\s*\((\d{4})\)\s*#(\d+)$/);
  if (match) {
    return {
      series: match[1].trim(),
      year: match[2],
      issue: match[3],
      originalTitle: title
    };
  }
  return null;
}

/** Generate series name variations */
function getSeriesVariations(series) {
  const variations = [series];

  // Add "The" prefix if not present
  if (!series.toLowerCase().startsWith('the ')) {
    variations.push(`The ${series}`);
  }

  // Remove "The" prefix if present
  if (series.toLowerCase().startsWith('the ')) {
    variations.push(series.substring(4).trim());
  }

  return variations;
}

/** Extract pattern from URL for caching */
function extractPatternFromUrl(url, site) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    let slug = '';

    if (site.key === 'readcomiconline') {
      // /Comic/slug-year/Issue-issue
      const match = path.match(/\/Comic\/([^\/]+)\/Issue-/);
      if (match) slug = match[1];
    } else if (site.key === 'viewcomics') {
      // /comic/slug-year/issue
      const match = path.match(/\/comic\/([^\/]+)\//);
      if (match) slug = match[1];
    } else if (site.key === 'readallcomics') {
      // /slug-year-001
      slug = path.substring(1); // remove leading /
      // Remove the issue part, assuming last 4 chars are -001
      if (slug.length > 4) {
        slug = slug.substring(0, slug.length - 4);
      }
    }

    if (!slug) return null;

    // Slug may be 'series-year' or 'series'
    const parts = slug.split('-');
    let year = null;
    let variation = '';

    if (parts.length > 1 && /^\d{4}$/.test(parts[parts.length - 1])) {
      year = parts[parts.length - 1];
      variation = parts.slice(0, -1).join('-');
    } else {
      variation = slug;
    }

    // Convert slug back to series name: replace - with space, capitalize words
    variation = variation.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    return { variation, year };
  } catch (e) {
    return null;
  }
}

/** Search Google with site: filter to find comic */
async function searchGoogleForComic(page, site, series, year, issue) {
  try {
    // Build Google search query
    const searchQuery = `${series} ${year} issue ${issue} site:${new URL(site.buildUrl('test', '2000', '1')).hostname}`;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    
    console.log(`      🔍 Searching Google: "${searchQuery}"`);
    
    const response = await page.goto(googleUrl, {
      waitUntil: 'domcontentloaded',
      timeout: GOOGLE_TIMEOUT
    });
    
    if (!response || response.status() !== 200) {
      console.log(`      ✗ Google search failed`);
      return null;
    }
    
    await wait(2000); // Wait for results to load
    
    // Extract first result link
    const firstLink = await page.evaluate((hostname) => {
      // Look for search result links
      const selectors = [
        'div.g a[href*="' + hostname + '"]',
        'a[href*="' + hostname + '"]'
      ];
      
      for (const selector of selectors) {
        const links = Array.from(document.querySelectorAll(selector));
        for (const link of links) {
          const href = link.href;
          // Make sure it's a direct link to the comic, not a search page
          if (href && 
              href.includes(hostname) && 
              !href.includes('/search') && 
              !href.includes('?s=') &&
              !href.includes('/Error')) {
            return href;
          }
        }
      }
      return null;
    }, new URL(site.buildUrl('test', '2000', '1')).hostname);
    
    if (firstLink) {
      console.log(`      ✓ Google found: ${firstLink.substring(0, 80)}...`);
      
      // Verify the link works
      const isValid = await verifyUrl(page, firstLink);
      if (isValid) {
        console.log(`      ✓ Link verified!`);
        return firstLink;
      } else {
        console.log(`      ✗ Link doesn't work`);
        return null;
      }
    } else {
      console.log(`      ✗ No results found on Google`);
      return null;
    }
    
  } catch (err) {
    console.log(`      ✗ Google search error: ${err.message}`);
    return null;
  }
}

function getSeriesCacheKey(series, year) {
  return `${series.toLowerCase()}:${year}`;
}

// ----- Read CSV -----
if (process.argv.length < 4) {
  console.error('Usage: node find_links_from_csv.js input.csv output.csv');
  process.exit(1);
}

const INPUT_CSV = process.argv[2];
const OUTPUT_CSV = process.argv[3];

if (!fs.existsSync(INPUT_CSV)) {
  console.error('Input CSV not found:', INPUT_CSV);
  process.exit(1);
}

async function readCsv(file) {
  return new Promise((res, rej) => {
    const rows = [];
    fs.createReadStream(file)
      .pipe(csv())
      .on('data', data => rows.push(data))
      .on('end', () => res(rows))
      .on('error', err => rej(err));
  });
}

/** Verify if a URL is valid */
async function verifyUrl(page, url) {
  try {
    console.log(`        → Navigating to URL...`);
    const response = await page.goto(url, { 
      waitUntil: 'networkidle2', // Wait for network to be idle
      timeout: DEFAULT_TIMEOUT 
    });
    
    console.log(`        → Status: ${response?.status()}`);
    
    if (!response || response.status() !== 200) {
      console.log(`        → Invalid status code`);
      return false;
    }
    
    const finalUrl = page.url();
    console.log(`        → Final URL: ${finalUrl.substring(0, 80)}...`);
    
    // Check for error redirects
    if (finalUrl.includes('/Error') || 
        finalUrl.includes('/error') || 
        finalUrl.includes('/404')) {
      console.log(`        → Detected error URL`);
      return false;
    }
    
    // Allow minor URL variations (like added query params)
    const urlBase = url.split('?')[0];
    const finalBase = finalUrl.split('?')[0];
    if (finalBase !== urlBase && !finalBase.startsWith(urlBase)) {
      console.log(`        → Redirected to different page`);
      return false;
    }
    
    // Wait a bit for dynamic content
    await wait(1500);
    
    // Check page content
    const pageInfo = await page.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      const body = (document.body.innerText || '').toLowerCase();
      
      return {
        title: title,
        bodyLength: body.length,
        hasError: title.includes('error') || 
                  title.includes('not found') || 
                  title.includes('404') ||
                  body.includes('page not found') || 
                  body.includes('404 error') || 
                  body.includes('not available'),
        bodyPreview: body.substring(0, 200)
      };
    });
    
    console.log(`        → Page title: ${pageInfo.title.substring(0, 60)}`);
    console.log(`        → Body length: ${pageInfo.bodyLength} chars`);
    
    if (pageInfo.hasError) {
      console.log(`        → Error content detected`);
      return false;
    }
    
    if (pageInfo.bodyLength < 300) {
      console.log(`        → Insufficient content`);
      return false;
    }
    
    console.log(`        → Page appears valid!`);
    return true;
    
  } catch (err) {
    console.log(`        → Exception: ${err.message}`);
    return false;
  }
}

/** Try to find working URL for a comic issue */
async function findWorkingUrl(page, site, series, year, issue) {
  const cacheKey = `${site.key}:${series}:${year}:${issue}`;
  
  // Check URL cache
  if (urlCache[cacheKey] !== undefined) {
    if (urlCache[cacheKey]) {
      console.log(`      ↻ Using cached URL`);
    }
    return urlCache[cacheKey];
  }
  
  // Check if we have a cached pattern for this series (even with different year)
  let cachedPattern = null;
  const seriesCacheKey = getSeriesCacheKey(series, year);
  
  // Try exact match first
  cachedPattern = seriesPatternCache[`${site.key}:${seriesCacheKey}`];
  
  // If not found, check if we have this series with any year
  if (!cachedPattern) {
    const seriesLower = series.toLowerCase();
    for (const key in seriesPatternCache) {
      if (key.startsWith(`${site.key}:${seriesLower}:`)) {
        cachedPattern = seriesPatternCache[key];
        console.log(`      ↻ Found cached pattern for series (different year)`);
        break;
      }
    }
  }
  
  // If we have a cached pattern, try it first
  if (cachedPattern) {
    console.log(`      ↻ Using cached pattern: "${cachedPattern.variation}" (${cachedPattern.year || 'no year'})`);
    const url = site.buildUrl(cachedPattern.variation, cachedPattern.year, issue);
    const isValid = await verifyUrl(page, url);
    
    if (isValid) {
      console.log(`      ✓ Valid: ${url}`);
      urlCache[cacheKey] = url;
      return url;
    } else {
      console.log(`      ✗ Cached pattern failed, trying fresh search...`);
    }
  }
  
  // Try different variations with the original year
  const variations = site.variations ? getSeriesVariations(series) : [series];
  
  for (const variation of variations) {
    const url = site.buildUrl(variation, year, issue);
    console.log(`      Testing: ${url.substring(0, 80)}...`);
    
    const isValid = await verifyUrl(page, url);
    
    if (isValid) {
      console.log(`      ✓ Found valid URL!`);
      urlCache[cacheKey] = url;
      
      // Cache this pattern for future issues
      seriesPatternCache[`${site.key}:${seriesCacheKey}`] = { variation, year };
      
      return url;
    }
    
    await wait(300);
  }
  
  // Try with year +/- 1
  console.log(`      ℹ Trying adjacent years...`);
  const adjacentYears = [parseInt(year) - 1, parseInt(year) + 1];
  
  for (const adjYear of adjacentYears) {
    for (const variation of variations) {
      const url = site.buildUrl(variation, adjYear.toString(), issue);
      console.log(`      Testing (${adjYear}): ${url.substring(0, 80)}...`);
      
      const isValid = await verifyUrl(page, url);
      
      if (isValid) {
        console.log(`      ✓ Found with year ${adjYear}!`);
        urlCache[cacheKey] = url;
        
        // Cache this pattern with the correct year - using ORIGINAL year as key
        seriesPatternCache[`${site.key}:${seriesCacheKey}`] = { variation, year: adjYear.toString() };
        
        return url;
      }
      
      await wait(300);
    }
  }
  
  // Try without year (if site supports it)
  if (site.tryWithoutYear) {
    console.log(`      ℹ Trying without year...`);
    for (const variation of variations) {
      const url = site.buildUrl(variation, null, issue);
      console.log(`      Testing (no year): ${url.substring(0, 80)}...`);
      
      const isValid = await verifyUrl(page, url);
      
      if (isValid) {
        console.log(`      ✓ Found without year!`);
        urlCache[cacheKey] = url;
        
        // Cache this pattern without year
        seriesPatternCache[`${site.key}:${seriesCacheKey}`] = { variation, year: null };
        
        return url;
      }
      
      await wait(300);
    }
  }
  
  // Last resort: Search Google (disabled due to timeout issues)
  console.log(`      ℹ Google search disabled due to timeout issues`);
  // const googleResult = await searchGoogleForComic(page, site, series, year, issue);
  //
  // if (googleResult) {
  //   urlCache[cacheKey] = googleResult;
  //
  //   // Try to extract pattern from the URL for caching
  //   const pattern = extractPatternFromUrl(googleResult, site);
  //   if (pattern) {
  //     console.log(`      📝 Extracted pattern from Google result: "${pattern.variation}" (${pattern.year || 'no year'})`);
  //     seriesPatternCache[`${site.key}:${seriesCacheKey}`] = pattern;
  //   }
  //
  //   return googleResult;
  // }
  
  console.log(`      ✗ No valid URL found`);
  urlCache[cacheKey] = null;
  return null;
}

/** Process single row */
async function processRow(page, row, siteKeys, stopOnFirstFind = true) {
  const title = row.Title || row.title || '';
  const parsed = parseComicTitle(title);
  
  const results = { ...row };
  for (const s of siteKeys) results[`${s}_link`] = '';
  
  if (!parsed) {
    console.log(`  ⚠ Could not parse title`);
    return results;
  }
  
  console.log(`  Series: "${parsed.series}" (${parsed.year}) #${parsed.issue}`);
  
  let foundOnAnySite = false;
  
  for (const site of SITES) {
    // Skip remaining sites if we already found a link
    if (stopOnFirstFind && foundOnAnySite) {
      console.log(`  ${site.name}: ⊘ Skipped (already found on another site)`);
      continue;
    }
    
    try {
      console.log(`  ${site.name}:`);
      const url = await findWorkingUrl(page, site, parsed.series, parsed.year, parsed.issue);
      
      if (url) {
        results[`${site.key}_link`] = url;
        foundOnAnySite = true;
      } else {
        results[`${site.key}_link`] = '';
      }
      
      await wait(400);
    } catch (err) {
      console.log(`      ✗ Error: ${err.message}`);
      results[`${site.key}_link`] = '';
    }
  }
  
  if (!foundOnAnySite) {
    console.log(`  ⚠ No links found on any site`);
  }
  
  return results;
}

/** Process in batches */
async function processBatch(browser, rows, startIdx, batchSize, siteKeys, csvWriter, stopOnFirstFind) {
  const endIdx = Math.min(startIdx + batchSize, rows.length);
  const batchResults = [];
  
  const page = await browser.newPage();
  
  // More human-like settings
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });
  
  // Set extra headers to look more like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  });
  
  // Block only heavy resources, keep CSS for proper rendering
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  for (let i = startIdx; i < endIdx; i++) {
    const row = rows[i];
    const title = row.Title || row.title || '';
    
    console.log(`\n[${i + 1}/${rows.length}] ${title}`);
    
    const result = await processRow(page, row, siteKeys, stopOnFirstFind);
    batchResults.push(result);
    
    // Save every 10 rows
    if (batchResults.length >= 10) {
      await csvWriter.writeRecords(batchResults);
      console.log(`\n  💾 Saved ${batchResults.length} rows to CSV`);
      batchResults.length = 0;
    }
    
    await wait(800); // Rate limiting between rows
  }
  
  // Save remaining
  if (batchResults.length > 0) {
    await csvWriter.writeRecords(batchResults);
    console.log(`\n  💾 Saved final ${batchResults.length} rows to CSV`);
  }
  
  await page.close();
}

// ----- Main -----
(async () => {
  console.log('Comic Link Finder - Direct URL Builder\n');
  
  const rows = await readCsv(INPUT_CSV);
  console.log(`Read ${rows.length} rows from ${INPUT_CSV}\n`);

  if (rows.length === 0) {
    console.error('No rows in CSV');
    process.exit(1);
  }

  const originalHeaders = Object.keys(rows[0]).map(h => ({ id: h, title: h }));
  const siteHeaders = SITES.map(s => ({ id: `${s.key}_link`, title: `${s.name} Link` }));
  const headers = [...originalHeaders, ...siteHeaders];

  const csvWriter = createCsvWriter({
    path: OUTPUT_CSV,
    header: headers
  });

  const browser = await puppeteer.launch({
    headless: true, // Keep visible to see what's happening
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080'
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: null
  });

  const siteKeys = SITES.map(s => s.key);
  const BATCH_SIZE = 100;
  const STOP_ON_FIRST_FIND = true; // Set to false to search all sites
  
  console.log('Strategy: Build URLs directly and verify they exist');
  console.log('Caching: Series patterns cached for speed');
  console.log(`Stop on first find: ${STOP_ON_FIRST_FIND ? 'YES' : 'NO'}\n`);
  console.log('='.repeat(70));
  
  try {
    const startTime = Date.now();
    
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
      
      console.log(`\n🔄 BATCH ${batchNum}/${totalBatches} (rows ${i + 1}-${Math.min(i + BATCH_SIZE, rows.length)})`);
      console.log('='.repeat(70));
      
      await processBatch(browser, rows, i, BATCH_SIZE, siteKeys, csvWriter, STOP_ON_FIRST_FIND);
      
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const rowsProcessed = Math.min(i + BATCH_SIZE, rows.length);
      const avgPerRow = ((Date.now() - startTime) / rowsProcessed / 1000).toFixed(1);
      const remaining = (avgPerRow * (rows.length - rowsProcessed) / 60).toFixed(1);
      
      console.log(`\n⏱️  Elapsed: ${elapsed}m | Avg: ${avgPerRow}s/row | Est. remaining: ${remaining}m`);
      console.log(`📊 Cached patterns: ${Object.keys(seriesPatternCache).length} | Cached URLs: ${Object.keys(urlCache).length}`);
      
      await wait(2000); // Pause between batches
    }
    
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const successCount = Object.values(urlCache).filter(v => v !== null).length;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`✓ COMPLETED in ${totalTime} minutes!`);
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log(`Processed: ${rows.length} rows`);
    console.log(`Found links: ${successCount} URLs`);
    console.log('='.repeat(70));
    
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await browser.close();
  }
})();