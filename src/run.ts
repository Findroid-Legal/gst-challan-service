/**
 * run.ts — THE MAIN SCRIPT (v3)
 *
 * Everything in ONE continuous browser session:
 * 1. Open browser
 * 2. Auto-fill username + password
 * 3. You type CAPTCHA + click Login
 * 4. Script takes over immediately after login
 * 5. Navigates to each section via portal menus (proper SSO flow)
 * 6. Captures all API responses
 * 7. Saves to output/
 *
 * Run: npm run start
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';
import * as dotenv from 'dotenv';
dotenv.config();

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const LOGIN_URL  = 'https://services.gst.gov.in/services/login';
const WELCOME_URL = 'https://services.gst.gov.in/services/auth/fowelcome';

// All captured API responses stored here
const captured: Record<string, any[]> = {
  notices:  [],
  returns:  [],
  ledger:   [],
  profile:  [],
  other:    [],
};

// ── Response listener ─────────────────────────────────────────────────────────
function attachCapture(page: any, label: string) {
  const SKIP = ['kaspersky-labs', 'google-analytics', 'youtube', 'googleapis',
                'newrelic', 'dynatrace', '.css', '.js', '.png', '.jpg',
                '.gif', '.woff', '.ico', '.svg'];

  page.on('response', async (res: any) => {
    const url = res.url();
    if (SKIP.some(s => url.includes(s))) return;
    if (res.status() < 200 || res.status() >= 400) return;

    try {
      const text = await res.text();
      if (!text || text.length < 10) return;
      if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) return;

      const data = JSON.parse(text);
      const keys = Array.isArray(data)
        ? (data[0] ? Object.keys(data[0]) : [])
        : Object.keys(data);

      const entry = {
        label,
        method: res.request().method(),
        url,
        status: res.status(),
        keys,
        data: JSON.stringify(data).length > 8000
          ? { _truncated: true, _keys: keys, _preview: JSON.stringify(data).slice(0, 8000) }
          : data,
        capturedAt: new Date().toISOString(),
      };

      const urlLow = url.toLowerCase();
      if (urlLow.includes('notice') || urlLow.includes('demand') || urlLow.includes('drc') || urlLow.includes('asmt')) {
        captured.notices.push(entry);
      } else if (urlLow.includes('return') || urlLow.includes('filing') || urlLow.includes('gstr') || urlLow.includes('snapshot')) {
        captured.returns.push(entry);
      } else if (urlLow.includes('ledger') || urlLow.includes('cash') || urlLow.includes('credit')) {
        captured.ledger.push(entry);
      } else if (urlLow.includes('profile') || urlLow.includes('taxpayer') || urlLow.includes('ustatus') || urlLow.includes('ustatus')) {
        captured.profile.push(entry);
      } else {
        captured.other.push(entry);
      }

      const shortUrl = url
        .replace('https://return.gst.gov.in', '[R]')
        .replace('https://services.gst.gov.in', '[S]');
      console.log(chalk.green(`  ✓ [${label}] ${shortUrl.slice(0, 90)}`));
      console.log(chalk.gray(`    Keys: ${keys.slice(0, 6).join(', ')}`));
    } catch {}
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function tryFill(page: any, selectors: string[], value: string) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        await el.fill('');
        await el.type(value, { delay: 60 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function ss(page: any, name: string) {
  await page.screenshot({ path: path.join(OUTPUT_DIR, `ss-${name}.png`) });
  console.log(chalk.gray(`  📸 ss-${name}.png`));
}

async function waitFor(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function toAbsUrl(href: string): string {
  if (!href) return '';
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return 'https://services.gst.gov.in' + href;
  return href;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const username = process.env.GST_USERNAME!;
  const password = process.env.GST_PASSWORD!;

  if (!username || !password) {
    console.error(chalk.red('Set GST_USERNAME + GST_PASSWORD in .env'));
    process.exit(1);
  }

  console.log(chalk.cyan('\n🚀 GST Scraper v3 — Full Session\n'));

  const context = await launchBrowser(false);
  const page    = await newPage(context);
  attachCapture(page, 'main');

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: LOGIN
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('━━━ PHASE 1: Login ━━━'));
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(2000);

  await tryFill(page, ['#username', 'input[name="username"]'], username);
  console.log(chalk.gray('  ✓ Username filled'));

  await tryFill(page, ['#user_pass', 'input[type="password"]'], password);
  console.log(chalk.gray('  ✓ Password filled'));

  console.log(chalk.bgYellow.black('\n  👆 Type the CAPTCHA in the browser, then click LOGIN  \n'));
  console.log(chalk.gray('  Waiting (up to 5 min)...\n'));

  const loginDeadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < loginDeadline) {
    await waitFor(1000);
    const url = page.url();
    if (!url.includes('/services/login')) {
      console.log(chalk.gray(`  URL changed to: ${url}`));
      break;
    }
  }

  // ── Hard check: did login actually succeed? ──────────────────────────────
  if (page.url().includes('/services/login')) {
    console.log(chalk.red('\n❌ Login timed out or failed — still on login page.'));
    console.log(chalk.yellow('   Make sure you type the CAPTCHA correctly and click LOGIN.'));
    console.log(chalk.yellow('   Run again: npm run start\n'));
    await ss(page, 'login-failed');
    await context.close();
    process.exit(1);
  }

  await waitFor(3000);

  // Handle OTP
  const bodyText = await page.locator('body').textContent().catch(() => '');
  if (bodyText?.includes('OTP') || page.url().includes('otp') || page.url().includes('verify')) {
    console.log(chalk.yellow('\n  📱 OTP screen — enter it in the browser (once ever)'));
    const otpDeadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < otpDeadline) {
      await waitFor(1500);
      const u = page.url();
      if (!u.includes('otp') && !u.includes('verify')) break;
    }
  }

  const postLoginUrl = page.url();
  console.log(chalk.green(`\n  ✅ Logged in! URL: ${postLoginUrl}`));
  await ss(page, '01-after-login');

  // Make sure we're on the fowelcome page
  if (!postLoginUrl.includes('fowelcome')) {
    await page.goto(WELCOME_URL, { waitUntil: 'load', timeout: 20000 });
    await waitFor(3000);
    console.log(chalk.gray(`  Navigated to: ${page.url()}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: NAVIGATE TO return.gst.gov.in via clicking menu link
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ PHASE 2: Navigate to Returns Portal ━━━'));

  let returnPortalReached = false;

  // Listen for frame navigation to return.gst.gov.in
  page.on('framenavigated', (frame: any) => {
    try {
      if (frame === page.mainFrame() && frame.url().includes('return.gst.gov.in')) {
        returnPortalReached = true;
      }
    } catch {}
  });

  // Strategy 1: Find and click the "Returns Dashboard" link directly
  // The portal nav has: "Returns Dashboard" → //return.gst.gov.in/returns/auth/dashboard
  // We got this from the link dump — it's a direct clickable link in the nav
  const returnNavLinks = [
    { text: 'Returns Dashboard',   url: 'https://return.gst.gov.in/returns/auth/dashboard' },
    { text: 'View Filed Returns',  url: 'https://return.gst.gov.in/returns/auth/efiledReturns' },
    { text: 'Track Return Status', url: 'https://return.gst.gov.in/returns/auth/trackreturnstatus' },
  ];

  for (const nav of returnNavLinks) {
    if (returnPortalReached) break;
    try {
      console.log(chalk.gray(`  Trying to click: "${nav.text}"...`));

      // Strategy A: navigate directly (with Referer set to fool WAF)
      await page.setExtraHTTPHeaders({
        'Referer': WELCOME_URL,
        'Origin': 'https://services.gst.gov.in',
      });
      await page.goto(nav.url, { waitUntil: 'load', timeout: 25000 });
      await waitFor(3000);

      const curUrl = page.url();
      console.log(chalk.gray(`    URL: ${curUrl}`));

      if (curUrl.includes('return.gst.gov.in') && !curUrl.includes('rejected') && !curUrl.includes('error')) {
        returnPortalReached = true;
        console.log(chalk.green(`  ✅ Reached return.gst.gov.in via direct nav!`));
        break;
      }

      // If direct nav failed, go back to fowelcome and try clicking
      await page.goto(WELCOME_URL, { waitUntil: 'load', timeout: 20000 });
      await waitFor(2000);

      // Strategy B: Click the link as a user would (triggers JS SSO redirect)
      const link = page.locator(`a:has-text("${nav.text}")`).first();
      if (await link.isVisible({ timeout: 2000 })) {
        console.log(chalk.gray(`    Clicking link in DOM...`));
        await link.click();
        await waitFor(5000);
        const afterClick = page.url();
        console.log(chalk.gray(`    URL after click: ${afterClick}`));
        if (afterClick.includes('return.gst.gov.in')) {
          returnPortalReached = true;
          console.log(chalk.green(`  ✅ Reached return.gst.gov.in via click!`));
          break;
        }
      }
    } catch (e: any) {
      console.log(chalk.gray(`    Error: ${e.message?.split('\n')[0]}`));
    }
  }

  await ss(page, '02-return-portal');

  // Strategy 2: Manual fallback — user clicks themselves
  if (!returnPortalReached) {
    // Navigate back to fowelcome first
    try {
      if (!page.url().includes('fowelcome')) {
        await page.goto(WELCOME_URL, { waitUntil: 'load', timeout: 20000 });
        await waitFor(2000);
      }
    } catch {}

    console.log(chalk.yellow('\n  ⚠️  Auto-navigation to Returns portal failed.'));
    console.log(chalk.bgYellow.black('  ══════════════════════════════════════════════════════'));
    console.log(chalk.bgYellow.black('  👆 In the browser, click ONE of these:               '));
    console.log(chalk.bgYellow.black('     • "Returns Dashboard" (in the Returns menu)       '));
    console.log(chalk.bgYellow.black('     • "View Filed Returns" (in Returns menu)           '));
    console.log(chalk.bgYellow.black('     • Any tile that says "Returns" on the dashboard   '));
    console.log(chalk.bgYellow.black('  ══════════════════════════════════════════════════════'));
    console.log(chalk.gray('\n  Waiting 3 minutes. Script continues on its own after...\n'));

    const manualDeadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < manualDeadline) {
      await waitFor(1000);
      if (page.url().includes('return.gst.gov.in')) {
        returnPortalReached = true;
        console.log(chalk.green(`  ✅ You navigated to return.gst.gov.in! URL: ${page.url()}`));
        break;
      }
      const rem = Math.round((manualDeadline - Date.now()) / 1000);
      if (rem % 30 === 0 && rem > 0 && rem < 180) {
        console.log(chalk.gray(`  Still waiting... ${rem}s left. URL: ${page.url()}`));
      }
    }
    await ss(page, '02b-manual-nav');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Scrape return.gst.gov.in sections FIRST (session is fresh now)
  // KEY: do ALL return.gst.gov.in navigation BEFORE going to services pages
  //      Once you leave return.gst.gov.in the WAF blocks re-entry.
  // ═══════════════════════════════════════════════════════════════════════════
  if (returnPortalReached) {
    console.log(chalk.white('\n━━━ PHASE 3: Scrape return.gst.gov.in sections ━━━'));
    console.log(chalk.gray('  (Must complete ALL these before moving to services.gst.gov.in)\n'));

    // Navigate the return portal via link clicks (not direct goto where possible)
    // This follows the natural user flow and avoids WAF blocks

    const returnPages = [
      // Dashboard first (already there) — scrape its APIs
      { name: 'Returns Dashboard',
        url:  'https://return.gst.gov.in/returns/auth/dashboard',
        waitMs: 6000 },
      // View Notices on return domain
      { name: 'View Notices (return)',
        url:  'https://return.gst.gov.in/returns/auth/viewnotices',
        waitMs: 8000 },
      // Filed returns list (correct URL from link dump)
      { name: 'Filed Returns List',
        url:  'https://return.gst.gov.in/returns/auth/efiledReturns',
        waitMs: 6000 },
      // Tax Liability Ledger (worked before)
      { name: 'Tax Liability Ledger',
        url:  'https://return.gst.gov.in/returns/auth/ledger/taxledger',
        waitMs: 6000 },
      // Credit Ledger
      { name: 'Credit Ledger',
        url:  'https://return.gst.gov.in/returns/auth/ledger/creditledger',
        waitMs: 6000 },
    ];

    for (const p of returnPages) {
      console.log(chalk.white(`  → ${p.name}`));
      try {
        // Try clicking the link in current page first (more natural than direct goto)
        let navigated = false;
        try {
          const link = page.locator(`a[href*="${p.url.replace('https://return.gst.gov.in', '')}"]`).first();
          if (await link.isVisible({ timeout: 1500 })) {
            await link.click();
            await waitFor(p.waitMs);
            navigated = true;
          }
        } catch {}

        // Fallback to direct navigation within return.gst.gov.in
        if (!navigated) {
          await page.goto(p.url, { waitUntil: 'load', timeout: 30000 });
          await waitFor(p.waitMs);
        }

        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
        await waitFor(2000);

        const url   = page.url();
        const title = await page.title().catch(() => '');
        console.log(chalk.gray(`    URL:   ${url}`));
        console.log(chalk.gray(`    Title: ${title}`));

        if (title.toLowerCase().includes('rejected') || url.includes('rejected')) {
          console.log(chalk.red(`    ❌ WAF blocked this page.`));
        }

        const sName = p.name.replace(/[\s()\/]/g, '-').replace(/-+/g, '-').toLowerCase();
        await ss(page, `03-${sName}`);
      } catch (e: any) {
        console.log(chalk.yellow(`    ⚠️  ${e.message?.split('\n')[0]}`));
      }
    }

    // ── Cash Ledger is on payment.gst.gov.in (different subdomain!) ─────────
    // Discovered from portal link dump: //payment.gst.gov.in/payment/auth/ledger/cashledger
    console.log(chalk.white('  → Cash Ledger (payment.gst.gov.in)'));
    try {
      await page.goto('https://payment.gst.gov.in/payment/auth/ledger/cashledger', {
        waitUntil: 'load', timeout: 30000,
      });
      await waitFor(6000);
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
      await waitFor(2000);
      const url   = page.url();
      const title = await page.title().catch(() => '');
      console.log(chalk.gray(`    URL:   ${url}`));
      console.log(chalk.gray(`    Title: ${title}`));
      await ss(page, '03-cash-ledger');
    } catch (e: any) {
      console.log(chalk.yellow(`    ⚠️  ${e.message?.split('\n')[0]}`));
    }

  } else {
    console.log(chalk.yellow('\n━━━ PHASE 3 SKIPPED — return.gst.gov.in session not established ━━━'));
    console.log(chalk.cyan('  TIP: After login, manually click "Returns Dashboard" in the nav menu.'));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2.5: Scrape services.gst.gov.in API pages
  // Do this AFTER return.gst.gov.in (return session is already done)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ PHASE 2.5: Scrape services.gst.gov.in pages ━━━\n'));

  const servicesPages = [
    // ── Notices (key data) ──
    {
      name: 'Notices and Orders',
      url:  'https://services.gst.gov.in/services/auth/notices',
      waitMs: 5000,
    },
    {
      name: 'Notices List (services2)',
      url:  'https://services.gst.gov.in/services2/auth/getlistofnotices',
      waitMs: 6000,
    },
    // ── Profile ──
    {
      name: 'My Profile',
      url:  'https://services.gst.gov.in/services/auth/myprofile',
      waitMs: 5000,
    },
    // ── Welcome dashboard ──
    {
      name: 'Welcome Dashboard',
      url:  WELCOME_URL,
      waitMs: 6000,
    },
  ];

  for (const sec of servicesPages) {
    console.log(chalk.white(`  → ${sec.name}`));
    try {
      await page.goto(sec.url, { waitUntil: 'load', timeout: 20000 });
      await waitFor(sec.waitMs);
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
      await waitFor(2000);

      const url   = page.url();
      const title = await page.title().catch(() => '');
      console.log(chalk.gray(`    URL:   ${url.slice(0, 100)}`));
      console.log(chalk.gray(`    Title: ${title}`));

      const sName = sec.name.replace(/[\s()\/]/g, '-').replace(/-+/g, '-').toLowerCase();
      await ss(page, `25-${sName}`);
    } catch (e: any) {
      console.log(chalk.yellow(`    ⚠️  ${e.message?.split('\n')[0]}`));
    }
  }

  await context.close();

  // ═══════════════════════════════════════════════════════════════════════════
  // SAVE RESULTS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ Results ━━━'));

  const totalEndpoints = Object.values(captured).flat().length;
  console.log(chalk.cyan(`\nTotal API responses captured: ${totalEndpoints}`));

  for (const [cat, entries] of Object.entries(captured)) {
    if (entries.length > 0) {
      const outPath = path.join(OUTPUT_DIR, `${cat}.json`);
      fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));
      console.log(chalk.green(`  ✅ ${cat}: ${entries.length} responses → output/${cat}.json`));
      entries.forEach(e => {
        const shortUrl = e.url
          .replace('https://return.gst.gov.in', '[R]')
          .replace('https://services.gst.gov.in', '[S]');
        console.log(chalk.gray(`     ${e.method} ${shortUrl.slice(0, 80)}`));
      });
    } else {
      console.log(chalk.gray(`  — ${cat}: nothing captured`));
    }
  }

  console.log(chalk.cyan('\n✅ Done. Check output/ folder.\n'));
}

main().catch(err => {
  console.error(chalk.red('\nFatal:'), err.message);
  process.exit(1);
});
