/**
 * find_links_resume.js - Resume Comic Link Finder
 *
 * Resumes from an existing output CSV
 * Skips rows that already have links
 *
 * Usage:
 *   node find_links_resume.js input.csv output.csv
 */

const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Caches
let urlCache = {};
let seriesPatternCache = {};

// Cache file paths
const CACHE_FILE = 'scraper_cache.json';

// ----- CONFIG -----
const SITE = {
  key: 'readcomiconline',
  name: 'ReadComicOnline',
  buildUrl: (series, year, issue) => {
    const slug = series.replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/g, '');
    if (year) {
      return `https://readcomiconline.li/Comic/${slug}-${year}/Issue-${issue}`;
    } else {
      return `https://readcomiconline.li/Comic/${slug}/Issue-${issue}`;
    }
  }
};

const DEFAULT_TIMEOUT = 20000;
const VERIFY_TIMEOUT = 10000;

/** Parse comic title */
function parseComicTitle(title) {
  let cleanTitle = title.replace(/\[.*?\]/g, '').trim();
  const match = cleanTitle.match(/^(.+?)\s*\((\d{4})\)\s*#(\d+)$/);
  if (match) {
    return {
      series: match[1].trim(),
      year: match[2],
      issue: match[3]
    };
  }
  return null;
}

/** Generate series name variations */
function getSeriesVariations(series) {
  const variations = [series];
  if (!series.toLowerCase().startsWith('the ')) {
    variations.push(`The ${series}`);
  }
  if (series.toLowerCase().startsWith('the ')) {
    variations.push(series.substring(4).trim());
  }
  return variations;
}

function getSeriesCacheKey(series, year) {
  return `${series.toLowerCase()}:${year}`;
}

/** Load cache from file */
function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      urlCache = data.urlCache || {};
      seriesPatternCache = data.seriesPatternCache || {};
      console.log(`Loaded cache: ${Object.keys(urlCache).length} URLs, ${Object.keys(seriesPatternCache).length} patterns`);
    } catch (err) {
      console.log('Could not load cache, starting fresh');
    }
  }
}

/** Save cache to file */
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ urlCache, seriesPatternCache }, null, 2));
  } catch (err) {
    console.error('Error saving cache:', err.message);
  }
}

// ----- Read CSV -----
if (process.argv.length < 4) {
  console.error('Usage: node find_links_resume.js input.csv output.csv');
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

/** Read existing output to find where we stopped */
async function readExistingOutput() {
  if (!fs.existsSync(OUTPUT_CSV)) {
    return [];
  }
  
  return new Promise((res, rej) => {
    const rows = [];
    fs.createReadStream(OUTPUT_CSV)
      .pipe(csv())
      .on('data', data => rows.push(data))
      .on('end', () => res(rows))
      .on('error', err => rej(err));
  });
}

/** Quick URL verification */
async function verifyUrl(page, url) {
  try {
    const response = await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: VERIFY_TIMEOUT 
    });
    
    if (!response || response.status() !== 200) {
      return false;
    }
    
    const finalUrl = page.url();
    
    if (finalUrl.includes('/Error') || finalUrl.includes('/error') || finalUrl.includes('/404')) {
      return false;
    }
    
    const urlBase = url.split('?')[0].split('#')[0];
    const finalBase = finalUrl.split('?')[0].split('#')[0];
    if (!finalBase.startsWith(urlBase.substring(0, urlBase.lastIndexOf('/')))) {
      return false;
    }
    
    await wait(500);
    
    const isValid = await page.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      const body = (document.body.innerText || '').toLowerCase();
      
      if (title.includes('error') || title.includes('not found') || title.includes('404')) {
        return false;
      }
      
      return body.length > 300;
    });
    
    return isValid;
    
  } catch (err) {
    return false;
  }
}

/** Find working URL for a comic issue */
async function findWorkingUrl(page, series, year, issue) {
  const cacheKey = `${series}:${year}:${issue}`;
  
  if (urlCache[cacheKey] !== undefined) {
    return urlCache[cacheKey];
  }
  
  let cachedPattern = null;
  const seriesCacheKey = getSeriesCacheKey(series, year);
  cachedPattern = seriesPatternCache[seriesCacheKey];
  
  if (!cachedPattern) {
    const seriesLower = series.toLowerCase();
    for (const key in seriesPatternCache) {
      if (key.startsWith(`${seriesLower}:`)) {
        cachedPattern = seriesPatternCache[key];
        break;
      }
    }
  }
  
  if (cachedPattern) {
    const url = SITE.buildUrl(cachedPattern.variation, cachedPattern.year, issue);
    const isValid = await verifyUrl(page, url);
    
    if (isValid) {
      urlCache[cacheKey] = url;
      return url;
    }
  }
  
  const variations = getSeriesVariations(series);
  
  for (const variation of variations) {
    const url = SITE.buildUrl(variation, year, issue);
    const isValid = await verifyUrl(page, url);
    
    if (isValid) {
      urlCache[cacheKey] = url;
      seriesPatternCache[seriesCacheKey] = { variation, year };
      return url;
    }
    
    await wait(200);
  }
  
  const adjacentYears = [parseInt(year) - 1, parseInt(year) + 1];
  
  for (const adjYear of adjacentYears) {
    for (const variation of variations) {
      const url = SITE.buildUrl(variation, adjYear.toString(), issue);
      const isValid = await verifyUrl(page, url);
      
      if (isValid) {
        urlCache[cacheKey] = url;
        seriesPatternCache[seriesCacheKey] = { variation, year: adjYear.toString() };
        return url;
      }
      
      await wait(200);
    }
  }
  
  for (const variation of variations) {
    const url = SITE.buildUrl(variation, null, issue);
    const isValid = await verifyUrl(page, url);
    
    if (isValid) {
      urlCache[cacheKey] = url;
      seriesPatternCache[seriesCacheKey] = { variation, year: null };
      return url;
    }
    
    await wait(200);
  }
  
  urlCache[cacheKey] = null;
  return null;
}

/** Process single row */
async function processRow(page, row) {
  const title = row.Title || row.title || '';
  const parsed = parseComicTitle(title);
  
  const results = { ...row, link: '' };
  
  if (!parsed) {
    return results;
  }
  
  try {
    const url = await findWorkingUrl(page, parsed.series, parsed.year, parsed.issue);
    results.link = url || '';
  } catch (err) {
    results.link = '';
  }
  
  return results;
}

/** Process in batches */
async function processBatch(browser, rows, startIdx, batchSize, csvWriter) {
  const endIdx = Math.min(startIdx + batchSize, rows.length);
  const batchResults = [];
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });
  
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
  
  for (let i = startIdx; i < endIdx; i++) {
    const row = rows[i];
    const title = row.Title || row.title || '';
    
    console.log(`[${i + 1}/${rows.length}] ${title}`);
    
    const result = await processRow(page, row);
    batchResults.push(result);
    
    if (result.link) {
      console.log(`  ✓ ${result.link}`);
    } else {
      console.log(`  ✗ Not found`);
    }
    
    if (batchResults.length >= 20) {
      await csvWriter.writeRecords(batchResults);
      saveCache(); // Save cache every 20 rows
      console.log(`  💾 Saved ${batchResults.length} rows + cache`);
      batchResults.length = 0;
    }
    
    await wait(500);
  }
  
  if (batchResults.length > 0) {
    await csvWriter.writeRecords(batchResults);
    saveCache();
    console.log(`  💾 Saved ${batchResults.length} rows + cache`);
  }
  
  await page.close();
}

// ----- Main -----
(async () => {
  console.log('Comic Link Finder - RESUME MODE\n');
  
  // Load cache
  loadCache();
  
  // Read input CSV
  const allRows = await readCsv(INPUT_CSV);
  console.log(`Read ${allRows.length} rows from input\n`);
  
  // Read existing output
  const existingRows = await readExistingOutput();
  console.log(`Found ${existingRows.length} existing rows in output\n`);
  
  // Determine which rows need processing
  let rowsToProcess = [];
  let startIndex = 0;
  
  if (existingRows.length === 0) {
    // No existing output, process all
    rowsToProcess = allRows;
    startIndex = 0;
  } else {
    // Skip rows that already have links
    startIndex = existingRows.length;
    rowsToProcess = allRows.slice(startIndex);
    console.log(`Resuming from row ${startIndex + 1}\n`);
  }
  
  if (rowsToProcess.length === 0) {
    console.log('All rows already processed!');
    process.exit(0);
  }

  const originalHeaders = Object.keys(allRows[0]).map(h => ({ id: h, title: h }));
  const headers = [...originalHeaders, { id: 'link', title: 'Link' }];

  const csvWriter = createCsvWriter({
    path: OUTPUT_CSV,
    header: headers,
    append: existingRows.length > 0 // Append if file exists
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security'
    ],
    ignoreHTTPSErrors: true
  });

  const BATCH_SIZE = 100;
  
  console.log('='.repeat(70));
  
  try {
    const startTime = Date.now();
    
    for (let i = 0; i < rowsToProcess.length; i += BATCH_SIZE) {
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(rowsToProcess.length / BATCH_SIZE);
      const actualRowNum = startIndex + i;
      
      console.log(`\nBATCH ${batchNum}/${totalBatches} (rows ${actualRowNum + 1}-${Math.min(actualRowNum + BATCH_SIZE, allRows.length)})`);
      console.log('='.repeat(70));
      
      await processBatch(browser, rowsToProcess, i, BATCH_SIZE, csvWriter);
      
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      const rowsProcessed = Math.min(i + BATCH_SIZE, rowsToProcess.length);
      const avgPerRow = ((Date.now() - startTime) / rowsProcessed / 1000).toFixed(1);
      const remaining = (avgPerRow * (rowsToProcess.length - rowsProcessed) / 60).toFixed(1);
      
      console.log(`\nElapsed: ${elapsed}m | Avg: ${avgPerRow}s/row | Remaining: ${remaining}m`);
      console.log(`Cache: ${Object.keys(seriesPatternCache).length} patterns | ${Object.keys(urlCache).length} URLs`);
      console.log(`Progress: ${startIndex + rowsProcessed}/${allRows.length} total rows`);
      
      await wait(1000);
    }
    
    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const successCount = Object.values(urlCache).filter(v => v !== null).length;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`COMPLETED in ${totalTime} minutes`);
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log(`Processed: ${rowsToProcess.length} rows (total: ${allRows.length})`);
    console.log(`Found: ${successCount} links`);
    console.log('='.repeat(70));
    
    // Clean up cache file
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
      console.log('Cache file cleaned up');
    }
    
  } catch (err) {
    console.error('Error:', err);
    saveCache();
    console.log('Cache saved for resume');
  } finally {
    await browser.close();
  }
})();
