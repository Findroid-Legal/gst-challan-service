/**
 * scrape-notices.ts
 *
 * Fetches all GST notices for the logged-in GSTIN.
 * Uses persistent profile — no OTP, no login prompt.
 *
 * Output: output/notices.json
 * Run:    npm run scrape:notices
 *
 * NOTE: Run explore.ts first. Check output/endpoint-map.json.
 * Update NOTICES_PAGE_URL below if the actual URL differs.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const NOTICES_PAGE_URL = 'https://return.gst.gov.in/returns/auth/viewnotices';

async function main() {
  console.log(chalk.cyan('\n📋 Fetching GST Notices...\n'));

  const context = await launchBrowser(true); // headless
  const page    = await newPage(context);
  const captured: any[] = [];

  page.on('response', async (res: any) => {
    const url = res.url();
    const ct  = res.headers()['content-type'] || '';
    if (!ct.includes('json') || res.status() !== 200) return;

    try {
      const data = await res.json();
      if (looksLikeNoticeData(url, data)) {
        console.log(chalk.green(`✓ ${url}`));
        captured.push({ sourceUrl: url, data, capturedAt: new Date().toISOString() });
      }
    } catch {}
  });

  await page.goto(NOTICES_PAGE_URL, { waitUntil: 'networkidle', timeout: 30000 });

  if (page.url().includes('/login')) {
    console.log(chalk.red('❌ Session expired. Run: npm run login'));
    await context.close();
    process.exit(1);
  }

  await page.waitForTimeout(4000);
  await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await page.waitForTimeout(2000);

  await context.close();

  if (captured.length === 0) {
    console.log(chalk.yellow('\n⚠️  Nothing captured. Run `npm run explore` first to confirm correct URL.\n'));
  } else {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'notices.json'), JSON.stringify(captured, null, 2));
    console.log(chalk.green(`\n✅ Saved → output/notices.json`));
    printSummary(captured);
  }
}

function looksLikeNoticeData(url: string, data: any): boolean {
  const urlLow = url.toLowerCase();
  if (urlLow.includes('notice') || urlLow.includes('demand') || urlLow.includes('drc') || urlLow.includes('asmt')) return true;
  const str = JSON.stringify(data || {}).toLowerCase();
  return str.includes('notice') || str.includes('demand') || str.includes('due_date') || str.includes('drc');
}

function printSummary(all: any[]) {
  console.log(chalk.cyan('\n📊 Summary:'));
  for (const e of all) {
    const d = e.data;
    console.log(chalk.white(`\n  Source: ${e.sourceUrl}`));
    if (Array.isArray(d)) {
      console.log(chalk.gray(`  Count:  ${d.length}`));
      if (d[0]) console.log(chalk.gray(`  Fields: ${Object.keys(d[0]).join(', ')}`));
    } else {
      console.log(chalk.gray(`  Keys:   ${Object.keys(d).join(', ')}`));
    }
  }
}

main().catch(err => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
