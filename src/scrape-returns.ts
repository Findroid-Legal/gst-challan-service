/**
 * scrape-returns.ts — uses persistent profile, no session file needed
 * Run: npm run scrape:returns
 */
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function main() {
  console.log(chalk.cyan('\n📋 Fetching Returns History...\n'));

  const context = await launchBrowser(true);
  const page    = await newPage(context);
  const captured: any[] = [];

  page.on('response', async (res: any) => {
    const url = res.url();
    const ct  = res.headers()['content-type'] || '';
    if (!ct.includes('json') || res.status() !== 200) return;
    try {
      const data = await res.json();
      const str  = JSON.stringify(data || {}).toLowerCase();
      if (url.toLowerCase().includes('return') || str.includes('gstr') || str.includes('ret_period')) {
        console.log(chalk.green(`✓ ${url}`));
        captured.push({ url, data, capturedAt: new Date().toISOString() });
      }
    } catch {}
  });

  await page.goto('https://return.gst.gov.in/returns/auth/returns', { waitUntil: 'networkidle', timeout: 30000 });
  if (page.url().includes('/login')) { console.log(chalk.red('Session expired — run: npm run login')); await context.close(); return; }
  await page.waitForTimeout(3000);
  await context.close();

  fs.writeFileSync(path.join(OUTPUT_DIR, 'returns.json'), JSON.stringify(captured, null, 2));
  console.log(chalk.green(`\n✅ Saved → output/returns.json  (${captured.length} endpoints)\n`));
}

main().catch(e => { console.error(chalk.red(e.message)); process.exit(1); });
