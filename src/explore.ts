/**
 * explore.ts
 *
 * Navigates the GST portal the way a human would — through menus.
 * Direct URL jumps to return.gst.gov.in are blocked by F5 WAF.
 * We must arrive there from services.gst.gov.in via menu clicks.
 *
 * Run: npm run explore
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const SKIP = [
  '.css', '.js', '.png', '.jpg', '.gif', '.woff', '.ico', '.svg',
  'kaspersky-labs.com', 'google-analytics', 'newrelic', 'dynatrace',
  'fonts.googleapis', 'cdn.jsdelivr',
];

interface Endpoint {
  page: string;
  method: string;
  url: string;
  status: number;
  responseKeys: string[];
  responseSample: any;
}

const allEndpoints: Endpoint[] = [];

function attachListener(page: any, pageName: string) {
  page.on('response', async (res: any) => {
    const url = res.url();
    if (SKIP.some(s => url.includes(s))) return;
    if (res.status() < 200 || res.status() >= 400) return;

    try {
      const text = await res.text();
      if (!text || text.length < 5) return;

      const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
      const ct     = res.headers()['content-type'] || '';

      // Log everything (so we can see ALL traffic)
      const shortUrl = url
        .replace('https://return.gst.gov.in', '[return]')
        .replace('https://services.gst.gov.in', '[services]');
      console.log(chalk.gray(`    [${res.status()}] ${res.request().method()} ${shortUrl.slice(0, 110)}`));

      if (!isJson) return;

      const data = JSON.parse(text);
      const keys = Array.isArray(data)
        ? (data[0] ? Object.keys(data[0]) : ['(empty array)'])
        : Object.keys(data);

      const strLen = JSON.stringify(data).length;
      const sample = strLen > 2000
        ? { _truncated: true, _size: strLen, _keys: keys, _preview: JSON.stringify(data).slice(0, 2000) }
        : data;

      allEndpoints.push({ page: pageName, method: res.request().method(), url, status: res.status(), responseKeys: keys, responseSample: sample });
      console.log(chalk.green(`    ✓ JSON keys: ${keys.slice(0, 8).join(', ')}`));
    } catch {}
  });
}

async function screenshot(page: any, name: string) {
  const file = path.join(OUTPUT_DIR, `page-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(chalk.gray(`  📸 ${file}`));
}

async function main() {
  console.log(chalk.cyan('\n🔭 GST Portal — Endpoint Explorer (human-navigation mode)\n'));

  const profileDir = path.resolve(__dirname, '..', 'profile');
  if (!fs.existsSync(profileDir)) {
    console.log(chalk.red('❌ No profile. Run: npm run login\n'));
    process.exit(1);
  }

  const context = await launchBrowser(false); // headed so we can watch

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: Start from the welcome page (where we land after login)
  // ─────────────────────────────────────────────────────────────────────────
  console.log(chalk.white('\n▶ Step 1: Welcome / Dashboard'));
  const welcomePage = await newPage(context);
  attachListener(welcomePage, 'Welcome');

  await welcomePage.goto('https://services.gst.gov.in/services/auth/fowelcome', {
    waitUntil: 'load', timeout: 30000,
  });
  await welcomePage.waitForTimeout(4000);
  console.log(chalk.gray(`  Landed: ${welcomePage.url()}`));
  await screenshot(welcomePage, 'welcome');

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: Navigate to Returns section via menu
  // ─────────────────────────────────────────────────────────────────────────
  console.log(chalk.white('\n▶ Step 2: Services → Returns'));
  try {
    // Try clicking "Services" menu then "Returns" submenu
    const servicesMenu = welcomePage.locator('a:has-text("Services"), li:has-text("Services")').first();
    if (await servicesMenu.isVisible({ timeout: 3000 })) {
      await servicesMenu.click();
      await welcomePage.waitForTimeout(1000);
      console.log(chalk.gray('  Clicked Services menu'));
    }

    // Look for Returns link
    const returnsLink = welcomePage.locator('a:has-text("Returns"), a[href*="return"]').first();
    if (await returnsLink.isVisible({ timeout: 3000 })) {
      console.log(chalk.gray('  Clicking Returns link...'));
      await returnsLink.click();
      await welcomePage.waitForTimeout(3000);
    }
  } catch (e: any) {
    console.log(chalk.yellow(`  ⚠️  Menu click failed: ${e.message.split('\n')[0]}`));
  }
  console.log(chalk.gray(`  URL now: ${welcomePage.url()}`));
  await screenshot(welcomePage, 'returns-nav');

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: Now try return.gst.gov.in pages WITH proper referer
  //         (we've established cross-domain session by visiting services first)
  // ─────────────────────────────────────────────────────────────────────────
  const returnPages = [
    { name: 'Returns Dashboard', url: 'https://return.gst.gov.in/returns/auth/dashboard' },
    { name: 'Returns List',      url: 'https://return.gst.gov.in/returns/auth/returns' },
    { name: 'View Notices',      url: 'https://return.gst.gov.in/returns/auth/viewnotices' },
    { name: 'Cash Ledger',       url: 'https://return.gst.gov.in/returns/auth/ledger/cashledger' },
    { name: 'Credit Ledger',     url: 'https://return.gst.gov.in/returns/auth/ledger/creditledger' },
    { name: 'Taxpayer Profile',  url: 'https://return.gst.gov.in/returns/auth/taxpayerprofile' },
  ];

  for (const p of returnPages) {
    console.log(chalk.white(`\n▶ ${p.name}`));
    const page = await newPage(context);
    attachListener(page, p.name);

    // Set Referer to simulate coming from services.gst.gov.in
    await page.setExtraHTTPHeaders({
      'Referer': 'https://services.gst.gov.in/services/auth/fowelcome',
    });

    try {
      await page.goto(p.url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(5000); // wait for XHR

      const url = page.url();
      console.log(chalk.gray(`  Landed: ${url}`));

      if (url.includes('rejected') || url.includes('accessdenied') || url.includes('error')) {
        console.log(chalk.red(`  ❌ Blocked/denied at this URL`));
      }
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠️  ${err.message.split('\n')[0]}`));
      await page.waitForTimeout(2000);
    }

    const screenshotName = p.name.replace(/\s+/g, '-').toLowerCase();
    await screenshot(page, screenshotName);
    await page.close();
  }

  await context.close();

  // ── Save + summary ──────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'endpoint-map.json'),
    JSON.stringify(allEndpoints, null, 2)
  );

  console.log(chalk.cyan('\n\n📊 SUMMARY\n'));
  console.log(`Total JSON endpoints captured: ${allEndpoints.length}`);

  if (allEndpoints.length > 0) {
    const byPage: Record<string, string[]> = {};
    for (const e of allEndpoints) {
      if (!byPage[e.page]) byPage[e.page] = [];
      byPage[e.page].push(`${e.method} ${e.url.replace('https://return.gst.gov.in', '').replace('https://services.gst.gov.in', '')}`);
    }
    for (const [pg, urls] of Object.entries(byPage)) {
      console.log(chalk.white(`\n${pg}:`));
      urls.forEach(u => console.log(chalk.gray(`  → ${u}`)));
    }
    console.log(chalk.cyan('\n✅ output/endpoint-map.json'));
  } else {
    console.log(chalk.yellow('\n⚠️  Still no JSON captured.'));
    console.log(chalk.yellow('   Check the screenshots in output/ to see what each page looks like.'));
    console.log(chalk.yellow('   The pages may need interaction (select GSTIN, date, click Search) to load data.'));
  }
}

main().catch(err => {
  console.error(chalk.red('Failed:'), err.message);
  process.exit(1);
});
