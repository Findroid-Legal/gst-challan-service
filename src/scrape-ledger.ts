/**
 * scrape-ledger.ts — uses persistent profile, no session file needed
 * Run: npm run scrape:ledger
 */
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const LEDGER_PAGES = [
  { name: 'Cash Ledger',      url: 'https://return.gst.gov.in/returns/auth/ledger/cashledger' },
  { name: 'Credit Ledger',    url: 'https://return.gst.gov.in/returns/auth/ledger/creditledger' },
  { name: 'Liability Ledger', url: 'https://return.gst.gov.in/returns/auth/ledger/liabilityledger' },
];

async function main() {
  console.log(chalk.cyan('\n💰 Fetching Ledgers...\n'));

  const context = await launchBrowser(true);
  const result: any = {};

  for (const ledger of LEDGER_PAGES) {
    const page     = await newPage(context);
    const captured: any[] = [];
    console.log(chalk.white(`\n→ ${ledger.name}`));

    page.on('response', async (res: any) => {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json') || res.status() !== 200) return;
      try {
        const data = await res.json();
        const str  = JSON.stringify(data || {}).toLowerCase();
        if (str.includes('igst') || str.includes('cgst') || str.includes('balance') || str.includes('credit')) {
          console.log(chalk.green(`  ✓ ${res.url()}`));
          captured.push({ url: res.url(), data });
        }
      } catch {}
    });

    await page.goto(ledger.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    result[ledger.name] = captured;
    await page.close();
  }

  await context.close();
  fs.writeFileSync(path.join(OUTPUT_DIR, 'ledger.json'), JSON.stringify(result, null, 2));
  console.log(chalk.green('\n✅ Saved → output/ledger.json\n'));
}

main().catch(e => { console.error(chalk.red(e.message)); process.exit(1); });
