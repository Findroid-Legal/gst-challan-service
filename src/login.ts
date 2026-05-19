/**
 * login.ts
 *
 * Semi-automated GST portal login.
 * Auto-fills: username + password
 * Manual:     CAPTCHA (you type it) + click Login
 *
 * Run: npm run login
 */

import chalk from 'chalk';
import * as fs from 'fs';
import { launchBrowser, newPage } from './browser';
import * as dotenv from 'dotenv';
dotenv.config();

if (!fs.existsSync('output')) fs.mkdirSync('output', { recursive: true });

const LOGIN_URL = 'https://services.gst.gov.in/services/login';

const DASHBOARD_MARKERS = [
  'return.gst.gov.in',
  '/returns/auth/dashboard',
  'taxpayerDashboard',
  '/services/auth/fowelcome',  // ← GST portal welcome page post-login
  '/auth/fowelcome',
];

async function main() {
  const username = process.env.GST_USERNAME;
  const password = process.env.GST_PASSWORD;

  if (!username || !password) {
    console.error(chalk.red('\n❌ Set GST_USERNAME and GST_PASSWORD in your .env file\n'));
    process.exit(1);
  }

  console.log(chalk.cyan('\n🔐 GST Portal Login\n'));
  console.log(chalk.gray(`   Username: ${username}`));

  const context = await launchBrowser(false); // visible browser
  const page    = await newPage(context);

  // ── Load login page ─────────────────────────────────────────────────────────
  console.log(chalk.white('\n→ Loading login page...'));
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // ── Fill username ────────────────────────────────────────────────────────────
  console.log(chalk.white('→ Filling username...'));
  const usernameFilled = await tryFill(page, [
    '#username',
    'input[name="username"]',
    'input[id="username"]',
    'input[placeholder*="Username" i]',
  ], username);

  if (!usernameFilled) {
    console.log(chalk.yellow('  ⚠️  Could not auto-fill username — fill it manually in the browser.'));
  }

  // ── Fill password ────────────────────────────────────────────────────────────
  console.log(chalk.white('→ Filling password...'));
  const passwordFilled = await tryFill(page, [
    '#user_pass',
    'input[type="password"]',
    'input[name="user_pass"]',
    'input[name="password"]',
  ], password);

  if (!passwordFilled) {
    console.log(chalk.yellow('  ⚠️  Could not auto-fill password — fill it manually in the browser.'));
  }

  await page.waitForTimeout(500);

  // ── Hand over to user ────────────────────────────────────────────────────────
  console.log(chalk.bgYellow.black('\n  ════════════════════════════════════════  '));
  console.log(chalk.bgYellow.black('  👆  Type the CAPTCHA in the browser         '));
  console.log(chalk.bgYellow.black('      then click the LOGIN button.            '));
  console.log(chalk.bgYellow.black('  ════════════════════════════════════════  \n'));
  console.log(chalk.gray('  Waiting for you (up to 5 minutes)...\n'));

  // ── Wait for URL to change — user clicked Login ──────────────────────────────
  // We watch for the page to navigate away from the login URL
  const leftLoginPage = await waitForNavigation(page, LOGIN_URL, 5 * 60 * 1000);

  if (!leftLoginPage) {
    console.log(chalk.red('\n❌ Timed out — you did not click Login within 5 minutes.'));
    await page.screenshot({ path: 'output/login-debug.png' });
    await context.close();
    process.exit(1);
  }

  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  console.log(chalk.gray(`\n→ Navigated to: ${currentUrl}`));

  // ── OTP screen? ──────────────────────────────────────────────────────────────
  if (await isOTPScreen(page)) {
    console.log(chalk.yellow('\n📱 OTP screen detected.'));
    console.log(chalk.green('   ➜ Enter the OTP in the browser now.'));
    console.log(chalk.gray('   This only happens ONCE on this machine. Waiting up to 3 min...\n'));

    await waitUntilDashboard(page, 3 * 60 * 1000);
  }

  // ── Login error? ─────────────────────────────────────────────────────────────
  if (await hasLoginError(page) || page.url().includes('/login')) {
    const msg = await getErrorText(page);
    console.log(chalk.red(`\n❌ Login failed — ${msg || 'wrong CAPTCHA or credentials'}`));
    await page.screenshot({ path: 'output/login-debug.png' });
    console.log(chalk.gray('   Screenshot → output/login-debug.png'));
    console.log(chalk.yellow('\n   Run again: npm run login\n'));
    await context.close();
    process.exit(1);
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  if (isDashboardUrl(page.url())) {
    const title = await page.title();
    console.log(chalk.green('\n✅ Logged in successfully!'));
    console.log(chalk.gray(`   URL:   ${page.url()}`));
    console.log(chalk.gray(`   Title: ${title}`));
    console.log(chalk.cyan('\n🎉 Profile saved to ./profile/'));
    console.log(chalk.white('   Next runs: username + password + CAPTCHA only. No OTP.\n'));
    console.log(chalk.white('Run next:'));
    console.log('  npm run session:check   ← verify headless access works');
    console.log('  npm run explore         ← map all portal endpoints');
    console.log('  npm run scrape:notices  ← fetch your GST notices\n');
  } else {
    console.log(chalk.yellow(`\n⚠️  Unknown state. URL: ${page.url()}`));
    await page.screenshot({ path: 'output/login-debug.png' });
    console.log(chalk.gray('   Screenshot → output/login-debug.png'));
  }

  await context.close();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function tryFill(page: any, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.fill('');
        await el.type(value, { delay: 60 });
        return true;
      }
    } catch {}
  }
  return false;
}

/** Wait until the URL is no longer the login page */
async function waitForNavigation(page: any, loginUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(800);
    const url = page.url();
    // If URL changed away from login page → user clicked Login
    if (!url.includes('/services/login') && url !== loginUrl) return true;
    // Also accept if OTP page appeared (some portals stay on same domain)
    if (await isOTPScreen(page)) return true;
  }
  return false;
}

async function isOTPScreen(page: any): Promise<boolean> {
  try {
    const url = page.url().toLowerCase();
    if (url.includes('otp') || url.includes('verify')) return true;
    const text = await page.locator('body').textContent({ timeout: 1000 });
    if (text?.includes('OTP') || text?.includes('One Time Password')) {
      // Make sure there's an OTP input
      if (await page.locator('input').count() < 5) return true; // OTP page has fewer fields
    }
  } catch {}
  return false;
}

async function hasLoginError(page: any): Promise<boolean> {
  try {
    const text = await page.locator('body').textContent({ timeout: 1000 });
    return !!(text?.toLowerCase().includes('invalid') || text?.toLowerCase().includes('incorrect'));
  } catch {}
  return false;
}

async function getErrorText(page: any): Promise<string> {
  const sels = ['.error', '.alert-danger', '[class*="error"]', '[class*="alert"]'];
  for (const s of sels) {
    try {
      const el = page.locator(s).first();
      if (await el.isVisible({ timeout: 500 })) {
        return (await el.textContent())?.trim() || '';
      }
    } catch {}
  }
  return '';
}

function isDashboardUrl(url: string): boolean {
  return DASHBOARD_MARKERS.some(m => url.includes(m));
}

async function waitUntilDashboard(page: any, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (isDashboardUrl(page.url())) return;
  }
}

main().catch(err => {
  console.error(chalk.red('\nFatal:'), err.message);
  process.exit(1);
});
