/**
 * browser.ts
 *
 * KEY CHANGE from v1:
 * We now use launchPersistentContext() instead of storageState files.
 *
 * WHY PERSISTENT CONTEXT?
 * ─────────────────────────────────────────────────────────────────
 * storageState saves cookies + localStorage.
 * But GST portal also uses browser fingerprint data (device ID,
 * hardware entropy, IndexedDB flags) to decide whether to ask for OTP.
 *
 * launchPersistentContext() = a REAL Chrome profile folder on disk.
 * It persists absolutely everything — cookies, localStorage, IndexedDB,
 * cached fingerprint tokens, service workers — just like a real Chrome
 * installation. The portal sees the same "device" every single run.
 *
 * Result: OTP is asked ONCE (first ever login on this machine).
 * After that: username + password + CAPTCHA → straight to dashboard.
 * ─────────────────────────────────────────────────────────────────
 */

import path from 'path';
import fs from 'fs';
import { chromium, BrowserContext } from 'playwright';
import * as dotenv from 'dotenv';
dotenv.config();

// Always resolve relative to the project root (one level up from src/)
const PROFILE_DIR = path.resolve(__dirname, '..', process.env.PROFILE_DIR || 'profile');

// Ensure profile dir exists
if (!fs.existsSync(PROFILE_DIR)) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

// Stealth args — remove all automation signals
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-notifications',
  '--lang=en-IN',
];

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Injected into every page — patches webdriver flag + other bot signals
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
`;

/**
 * Launch with a persistent Chrome profile.
 * headless=false → visible browser (for login + CAPTCHA solving feedback)
 * headless=true  → invisible (for background scraping runs)
 */
export async function launchBrowser(headless: boolean = false): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    slowMo: headless ? 0 : 30,
    args: STEALTH_ARGS,
    userAgent: USER_AGENT,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: headless ? { width: 1366, height: 768 } : null,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
    },
  });

  // Patch every new page with stealth JS
  await context.addInitScript(STEALTH_SCRIPT);

  return context;
}

/**
 * Convenience: open a new page in an existing context
 */
export async function newPage(context: BrowserContext) {
  const page = await context.newPage();
  return page;
}
