/**
 * server.ts — GST Challan Microservice
 *
 * Wraps the Playwright challan flow in an HTTP API.
 * Runs headless on Railway. React app calls these endpoints.
 *
 * Flow:
 *   POST /api/challan/start         → { sessionId, captchaImage }
 *   POST /api/challan/:id/login     → { ok } | { error, captchaImage }   (re-try on wrong CAPTCHA)
 *   POST /api/challan/:id/generate  → 202 accepted (async)
 *   GET  /api/challan/:id/status    → { state, logs, result?, error? }
 *   GET  /api/challan/payment-status/:cpin  → { status: PAID|PENDING|FAILED }
 *   GET  /health
 *
 * Each session gets its own persistent profile dir (./profiles/{sessionId})
 * so multiple users run independently and OTP is only asked once per device.
 *
 * Run locally : npm run server
 * Deploy      : Railway — set PORT env var
 */

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT || '3001');
const PROFILES_DIR  = path.join(__dirname, '..', 'profiles');
const SESSION_TTL   = 15 * 60 * 1000; // 15 min per session
const CORS_ORIGIN   = process.env.CORS_ORIGIN || '*';

if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

// ── Types ─────────────────────────────────────────────────────────────────────
type SessionState =
  | 'captcha_pending'   // Browser open, credentials filled, waiting for CAPTCHA text
  | 'logging_in'        // CAPTCHA submitted, waiting for login
  | 'ready'             // Logged in, ready to generate
  | 'generating'        // Challan flow running
  | 'done'              // Challan + gateway URL ready
  | 'error';            // Something went wrong

interface ChallanResult {
  cpin:        string;
  gatewayUrl:  string;
  pdfBase64?:  string;
  amount:      number;
  bank:        string;
  payMode:     string;
  ts:          string;
}

interface Session {
  id:          string;
  context:     BrowserContext;
  page:        Page;
  state:       SessionState;
  logs:        string[];
  result?:     ChallanResult;
  error?:      string;
  createdAt:   number;
  profileDir:  string;
}

const sessions = new Map<string, Session>();

// ── Stealth browser args (same as browser.ts) ─────────────────────────────────
const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-infobars', '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run', '--no-zygote', '--disable-notifications',
  '--lang=en-IN',
];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins',   { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-IN','en-US','en'] });
  window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'platform',  { get: () => 'Win32' });
`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function addLog(s: Session, msg: string) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  s.logs.push(line);
  console.log(`[${s.id.slice(0, 8)}] ${msg}`);
}

function cleanupSession(s: Session) {
  try { s.context.close(); } catch {}
  try { fs.rmSync(s.profileDir, { recursive: true, force: true }); } catch {}
  sessions.delete(s.id);
}

// ── Session TTL cleanup ───────────────────────────────────────────────────────
setInterval(() => {
  for (const [, s] of sessions) {
    if (Date.now() - s.createdAt > SESSION_TTL) {
      console.log(`[cleanup] Session ${s.id.slice(0, 8)} expired`);
      cleanupSession(s);
    }
  }
}, 60_000);

// ── Angular helpers ───────────────────────────────────────────────────────────
async function angularClick(page: Page, id: string) {
  await page.evaluate((elId: string) => {
    try {
      const el = document.getElementById(elId) as HTMLInputElement | null;
      if (!el) return;
      el.checked = true;
      (window as any).angular.element(el).triggerHandler('click');
      const root = (window as any).angular.element(document.body).injector().get('$rootScope');
      if (!root.$$phase) root.$apply();
    } catch {}
  }, id);
}

async function callAngularFn(page: Page, fnName: string): Promise<boolean> {
  return page.evaluate((fn: string) => {
    try {
      const els = document.querySelectorAll('[ng-controller],[data-ng-controller],body');
      for (let i = 0; i < els.length; i++) {
        const scope = (window as any).angular.element(els[i]).scope();
        if (scope && typeof scope[fn] === 'function') {
          scope[fn]();
          if (!scope.$root.$$phase) scope.$apply();
          return true;
        }
      }
      return false;
    } catch { return false; }
  }, fnName);
}

// ── Fill an amount field ──────────────────────────────────────────────────────
async function fillAmount(page: Page, head: string, amount: number): Promise<boolean> {
  if (amount <= 0) return true;
  const sels = [
    `input[name="${head}_tax_amt"]`,
    `input[name=" ${head}_tax_amt"]`,
    `input[data-ng-model="challanData.${head}_tax_amt"]`,
    `input[name*="${head}"][name*="tax"]`,
  ];
  for (const sel of sels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ clickCount: 3 });
        await el.fill(String(amount));
        await el.dispatchEvent('input');
        await el.dispatchEvent('change');
        return true;
      }
    } catch {}
  }
  return false;
}

// ── Extract CAPTCHA image as base64 ──────────────────────────────────────────
async function extractCaptcha(page: Page): Promise<string> {
  // Try to screenshot just the CAPTCHA image element
  const sels = [
    'img#imgCaptcha',
    'img[id*="captcha" i]',
    'img[src*="captcha" i]',
    'img[alt*="captcha" i]',
    '.captcha img',
    '#captchaImage',
    'img#captcha',
  ];
  for (const sel of sels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        const buf = await el.screenshot({ type: 'png' });
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    } catch {}
  }
  // Fallback: screenshot the whole viewport (cropped top area where CAPTCHA usually is)
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1366, height: 768 } });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// ── Fill CAPTCHA input and submit login ───────────────────────────────────────
async function fillCaptchaAndLogin(page: Page, text: string): Promise<void> {
  const inputSels = [
    '#userCaptcha', '#captcha', '#captchaText',
    'input[name="captcha"]', 'input[name="userCaptcha"]',
    'input[id*="captcha" i]', 'input[placeholder*="captcha" i]',
    // Last text input on the page (CAPTCHA is typically the last)
    'input[type="text"]:last-of-type',
  ];
  let filled = false;
  for (const sel of inputSels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ clickCount: 3 });
        await el.fill(text);
        filled = true;
        break;
      }
    } catch {}
  }
  if (!filled) throw new Error('CAPTCHA input field not found');

  // Click login button
  const btnSels = [
    'button[id*="login" i]',  'button[id*="submit" i]',
    'input[type="submit"]',   'button[type="submit"]',
    'button:has-text("LOGIN")', 'button:has-text("Login")',
    'a:has-text("LOGIN")',
  ];
  for (const sel of btnSels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click();
        return;
      }
    } catch {}
  }
  throw new Error('Login button not found');
}

// ── Core challan flow (runs async after /generate is called) ──────────────────
async function runChallanFlow(
  session: Session,
  opts: { igst: number; cgst: number; sgst: number; cess: number;
          interest: number; penalty: number; fee: number; payMode: string }
) {
  const { page } = session;
  const { igst, cgst, sgst, cess, interest, penalty, fee, payMode } = opts;
  const total = igst + cgst + sgst + cess + interest + penalty + fee;

  try {
    // ── SSO: Return portal ──────────────────────────────────────
    addLog(session, 'Activating SSO via return portal...');
    await page.setExtraHTTPHeaders({
      'Referer': 'https://services.gst.gov.in/services/auth/fowelcome',
      'Origin':  'https://services.gst.gov.in',
    });
    await page.goto('https://return.gst.gov.in/returns/auth/dashboard',
      { waitUntil: 'load', timeout: 30000 });
    await sleep(4000);
    await page.setExtraHTTPHeaders({});

    // ── Cashledger ──────────────────────────────────────────────
    addLog(session, 'Navigating to cashledger...');
    await page.goto('https://payment.gst.gov.in/payment/auth/ledger/cashledger',
      { waitUntil: 'load', timeout: 30000 });
    await sleep(3000);
    if (!page.url().includes('payment.gst.gov.in')) {
      addLog(session, 'Retrying cashledger with Referer...');
      await page.setExtraHTTPHeaders({ 'Referer': 'https://return.gst.gov.in/returns/auth/dashboard' });
      await page.goto('https://payment.gst.gov.in/payment/auth/ledger/cashledger',
        { waitUntil: 'load', timeout: 30000 });
      await sleep(3000);
      await page.setExtraHTTPHeaders({});
    }
    if (!page.url().includes('payment.gst.gov.in'))
      throw new Error(`Cannot reach payment portal. URL: ${page.url()}`);

    // ── Navigate to challanreason ───────────────────────────────
    addLog(session, 'Navigating to challan form...');
    await page.evaluate(() => {
      (window as any).location.href = 'https://payment.gst.gov.in/payment/auth/';
    });
    try { await page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }); } catch {}
    await sleep(5000);

    // ── Select AOP radio ────────────────────────────────────────
    addLog(session, 'Selecting AOP...');
    try { await page.locator('#aop').click({ timeout: 3000 }); } catch {}
    await angularClick(page, 'aop');
    await sleep(1000);

    // ── Wait for + click PROCEED ────────────────────────────────
    addLog(session, 'Clicking PROCEED...');
    let proceedDone = false;
    for (let i = 0; i < 10 && !proceedDone; i++) {
      const disabled = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-ng-click*="onProceed"],button[ng-click*="onProceed"]');
        return btn ? (btn.disabled || btn.getAttribute('disabled') !== null) : true;
      });
      if (!disabled) {
        try {
          await page.locator('button[title="Proceed"]').click({ timeout: 3000 });
          proceedDone = true;
        } catch {}
      }
      if (!proceedDone) await sleep(500);
    }
    if (!proceedDone) {
      await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>(
          'button[data-ng-click*="onProceed"],button[ng-click*="onProceed"]');
        if (btn) { btn.removeAttribute('disabled'); btn.disabled = false; btn.click(); }
      });
    }
    await sleep(4000);

    // ── Fill amounts ────────────────────────────────────────────
    addLog(session, `Filling: IGST=${igst} CGST=${cgst} SGST=${sgst} CESS=${cess}`);
    if (igst     > 0) await fillAmount(page, 'igst', igst);
    if (cgst     > 0) await fillAmount(page, 'cgst', cgst);
    if (sgst     > 0) await fillAmount(page, 'sgst', sgst);
    if (cess     > 0) await fillAmount(page, 'cess', cess);
    if (interest > 0) {
      const iSels = [`input[name="igst_int_amt"]`, `input[name="cgst_int_amt"]`];
      for (const sel of iSels) {
        try {
          if (await page.locator(sel).isVisible({ timeout: 800 })) {
            await page.locator(sel).first().fill(String(interest)); break;
          }
        } catch {}
      }
    }
    await sleep(500);

    // ── E-Payment ───────────────────────────────────────────────
    addLog(session, 'Selecting E-Payment...');
    for (const sel of ['li#pay1 a', 'a[data-ng-click="EPY()"]', 'a[ng-click="EPY()"]']) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 1500 })) {
          await page.locator(sel).first().click();
          break;
        }
      } catch {}
    }
    await sleep(2000);

    // ── Generate Challan ────────────────────────────────────────
    addLog(session, 'Generating challan...');
    const btnEnabled = await page.evaluate(() => {
      const btn = document.getElementById('forEpay') as HTMLButtonElement | null;
      return btn && !btn.disabled;
    });
    if (btnEnabled) {
      await page.locator('#forEpay').click({ timeout: 5000 });
    } else {
      await page.evaluate(() => {
        const btn = document.getElementById('forEpay') as HTMLButtonElement | null;
        if (!btn) return;
        btn.removeAttribute('disabled'); btn.disabled = false;
        const scope = (window as any).angular.element(btn).scope();
        if (scope?.generatechallan) {
          scope.generatechallan();
          if (!scope.$root.$$phase) scope.$apply();
        } else btn.click();
      });
    }
    await sleep(5000);

    // ── Extract CPIN ────────────────────────────────────────────
    addLog(session, 'Extracting CPIN...');
    const bodyText = await page.locator('body').textContent() as string;
    const cpinM = bodyText.match(/(?:CPIN|cpin)[^\d]*(\d{14,18})/i)
               || bodyText.match(/\b(\d{14,18})\b/);
    if (!cpinM) throw new Error('CPIN not found');
    const cpin = cpinM[1] || cpinM[0].replace(/\D/g, '');
    addLog(session, `CPIN: ${cpin}`);

    // ── PDF (page snapshot before navigating away) ──────────────
    addLog(session, 'Saving PDF...');
    let pdfBase64: string | undefined;
    try {
      const pdfBuf = await page.pdf({ printBackground: true, format: 'A4' });
      pdfBase64 = pdfBuf.toString('base64');
    } catch {}

    // ── Select payment sub-mode ─────────────────────────────────
    const isUPI = payMode.toUpperCase() === 'UPI';
    addLog(session, `Selecting payment mode: ${isUPI ? 'BHIM UPI' : 'Net Banking'}`);

    const payTabSels = isUPI
      ? ['li#upi a', 'a[data-ng-click="UPI()"]']
      : ['li#nb a',  'a[data-ng-click="NB()"]'];

    let payTabClicked = false;
    for (const sel of payTabSels) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 2000 })) {
          await page.locator(sel).first().click();
          payTabClicked = true;
          break;
        }
      } catch {}
    }
    if (!payTabClicked) {
      await callAngularFn(page, isUPI ? 'UPI' : 'NB');
    }
    await sleep(3000);

    // ── Select first available bank ─────────────────────────────
    addLog(session, 'Finding first available bank...');
    const bankInputs = await page.evaluate((): { id: string; value: string }[] => {
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="radio"][id], input[id][value]')
      );
      return inputs
        .filter(el => el.id && el.id !== 'checkbox-consent' && el.offsetParent !== null)
        .map(el => ({ id: el.id, value: el.value }));
    });

    addLog(session, `Banks available: ${bankInputs.map(b => b.id).join(', ')}`);

    let selectedBank = '';
    if (bankInputs.length > 0) {
      selectedBank = bankInputs[0].id;
      try { await page.locator(`input#${selectedBank}`).click({ timeout: 2000 }); } catch {}
      await angularClick(page, selectedBank);
      addLog(session, `Selected first bank: ${selectedBank}`);
    }

    // ── Consent checkbox ────────────────────────────────────────
    try {
      const consent = page.locator('input#checkbox-consent');
      if (await consent.isVisible({ timeout: 1500 })) {
        await consent.click();
        await angularClick(page, 'checkbox-consent');
        addLog(session, 'Consent checked');
      }
    } catch {}
    await sleep(1000);

    // ── Wait for Make Payment to enable ─────────────────────────
    addLog(session, 'Waiting for Make Payment to enable...');
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const ready = await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>('button[title="Make Payment"]');
        return btn && !btn.disabled && btn.getAttribute('disabled') === null;
      });
      if (ready) break;
    }

    // ── Click Make Payment ──────────────────────────────────────
    addLog(session, 'Clicking Make Payment...');
    let mpDone = false;
    try {
      await page.locator('button[title="Make Payment"]').click({ timeout: 5000 });
      mpDone = true;
    } catch {}

    if (!mpDone) {
      const called = await callAngularFn(page, 'saveBankAndPayNow');
      if (!called) {
        await page.evaluate(() => {
          const form = document.querySelector<HTMLElement>('form[name="generatedChallanPage"]');
          if (!form) return;
          const scope = (window as any).angular.element(form).scope();
          if (scope?.saveBankAndPayNow) {
            scope.saveBankAndPayNow();
            if (!scope.$root.$$phase) scope.$apply();
          }
        });
      }
    }

    // ── Wait for payment gateway redirect ───────────────────────
    addLog(session, 'Waiting for payment gateway URL...');
    await sleep(8000);
    const gatewayUrl = page.url();
    addLog(session, `Gateway URL: ${gatewayUrl}`);

    // ── Store result ────────────────────────────────────────────
    session.result = {
      cpin,
      gatewayUrl,
      pdfBase64,
      amount: total,
      bank: selectedBank,
      payMode,
      ts: new Date().toISOString(),
    };
    session.state = 'done';
    addLog(session, `✅ Done! CPIN=${cpin}`);

  } catch (err: any) {
    session.state = 'error';
    session.error = err.message;
    addLog(session, `❌ Error: ${err.message}`);
  }
  // Keep context open so app can close it explicitly (or TTL cleanup)
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));

// CORS
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, sessions: sessions.size, ts: new Date().toISOString() });
});

// ── POST /session/start ───────────────────────────────────────────────────────
// Start headless browser, fill credentials, return CAPTCHA image
app.post('/session/start', async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return void res.status(400).json({ error: 'username and password required' });

  const id = randomUUID();
  const profileDir = path.join(PROFILES_DIR, id);
  fs.mkdirSync(profileDir, { recursive: true });

  let context: BrowserContext, page: Page;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless:            true,
      args:                STEALTH_ARGS,
      userAgent:           USER_AGENT,
      locale:              'en-IN',
      timezoneId:          'Asia/Kolkata',
      viewport:            { width: 1366, height: 768 },
      ignoreHTTPSErrors:   true,
      extraHTTPHeaders:    { 'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8' },
    });
    await context.addInitScript(STEALTH_SCRIPT);
    page = await context.newPage();
  } catch (err: any) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    return void res.status(500).json({ error: `Browser launch failed: ${err.message}` });
  }

  const session: Session = {
    id, context, page,
    state: 'captcha_pending',
    logs: [],
    createdAt: Date.now(),
    profileDir,
  };
  sessions.set(id, session);
  addLog(session, `Session started for ${username}`);

  try {
    addLog(session, 'Loading GST login page...');
    await page.goto('https://services.gst.gov.in/services/login',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Fill username
    for (const sel of ['#username', 'input[name="username"]', 'input[type="text"]:first-of-type']) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 1000 })) {
          await page.locator(sel).first().fill(username); break;
        }
      } catch {}
    }

    // Fill password
    for (const sel of ['#user_pass', 'input[type="password"]']) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 1000 })) {
          await page.locator(sel).first().fill(password); break;
        }
      } catch {}
    }

    addLog(session, 'Extracting CAPTCHA...');
    const captchaImage = await extractCaptcha(page);
    addLog(session, 'CAPTCHA ready — waiting for user input');

    res.json({ sessionId: id, captchaImage });

  } catch (err: any) {
    addLog(session, `Start error: ${err.message}`);
    cleanupSession(session);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /session/:id/login ───────────────────────────────────────────────────
// Submit CAPTCHA text → complete login
// Always returns HTTP 200; wrong CAPTCHA → { ok: false, captchaImage, error }
app.post('/session/:id/login', async (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session)              return void res.status(404).json({ error: 'Session not found' });
  if (session.state !== 'captcha_pending')
    return void res.status(400).json({ error: `Invalid state: ${session.state}` });

  const { captcha } = req.body || {};
  if (!captcha) return void res.status(400).json({ error: 'captcha required' });

  session.state = 'logging_in';
  addLog(session, `Submitting CAPTCHA: "${captcha}"`);

  try {
    const { page } = session;
    await fillCaptchaAndLogin(page, captcha);

    // Wait up to 30s for navigation away from login
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(500);
      if (!page.url().includes('/services/login')) break;
    }

    if (page.url().includes('/services/login')) {
      // Still on login — wrong CAPTCHA; return HTTP 200 with ok:false + fresh image
      session.state = 'captcha_pending';
      addLog(session, 'Login failed (wrong CAPTCHA?) — refreshing CAPTCHA');
      const captchaImage = await extractCaptcha(page);
      return void res.json({ ok: false, error: 'Wrong CAPTCHA — try again.', captchaImage });
    }

    await sleep(2000);
    session.state = 'ready';
    addLog(session, `Logged in ✅  URL: ${page.url()}`);
    res.json({ ok: true });

  } catch (err: any) {
    session.state = 'error';
    session.error = err.message;
    addLog(session, `Login error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /session/:id/generate ────────────────────────────────────────────────
// Start challan generation async — returns 202; poll /session/:id/status
// Body: { amounts: { igst, cgst, sgst, cess, interest, penalty, fee } }
app.post('/session/:id/generate', async (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session)           return void res.status(404).json({ error: 'Session not found' });
  if (session.state !== 'ready')
    return void res.status(400).json({ error: `Invalid state: ${session.state}` });

  const { amounts = {} } = req.body || {};
  const {
    igst = 0, cgst = 0, sgst = 0, cess = 0,
    interest = 0, penalty = 0, fee = 0,
  } = amounts as Record<string, number>;
  const payMode = 'UPI'; // always UPI for this flow

  const total = igst + cgst + sgst + cess + interest + penalty + fee;
  if (total <= 0) return void res.status(400).json({ error: 'Total amount must be > 0' });

  session.state = 'generating';
  addLog(session, `Starting challan: ₹${total} (IGST=${igst} CGST=${cgst} SGST=${sgst} CESS=${cess})`);

  // Accept immediately; run in background
  res.status(202).json({ ok: true, message: 'Generation started — poll GET /session/:id/status' });

  runChallanFlow(session, { igst, cgst, sgst, cess, interest, penalty, fee, payMode })
    .catch(err => {
      session.state = 'error';
      session.error = err.message;
      addLog(session, `Unhandled error: ${err.message}`);
    });
});

// ── GET /session/:id/status ───────────────────────────────────────────────────
// Poll after /generate — returns simplified state + live logs + final result
app.get('/session/:id/status', (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) return void res.status(404).json({ error: 'Session not found' });

  // Map internal state → simplified API state
  const stateMap: Record<string, string> = {
    captcha_pending: 'pending',
    logging_in:      'pending',
    ready:           'pending',
    generating:      'generating',
    done:            'done',
    error:           'error',
  };

  res.json({
    state:  stateMap[session.state] ?? 'pending',
    logs:   session.logs.slice(-30),
    result: session.result,
    error:  session.error,
  });
});

// ── POST /session/:id/captcha/refresh ────────────────────────────────────────
// Get a fresh CAPTCHA screenshot from the headless browser
app.post('/session/:id/captcha/refresh', async (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) return void res.status(404).json({ error: 'Session not found' });

  try {
    const captchaImage = await extractCaptcha(session.page);
    res.json({ captchaImage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /session/:id/close ───────────────────────────────────────────────────
// Explicitly close a session and free its browser process + profile dir
app.post('/session/:id/close', (req: Request, res: Response) => {
  const session = sessions.get(String(req.params.id));
  if (!session) return void res.status(404).json({ error: 'Session not found' });
  cleanupSession(session);
  res.json({ ok: true });
});

// ── GET /payment/:cpin/status ─────────────────────────────────────────────────
// Check if payment for a CPIN has been received
// Uses the GST portal's public track-payment API (no auth required)
app.get('/payment/:cpin/status', async (req: Request, res: Response) => {
  const cpin = String(req.params.cpin);
  if (!cpin.match(/^\d{14,18}$/))
    return void res.status(400).json({ error: 'Invalid CPIN format' });

  try {
    // GST portal public track payment status API
    const axios = (await import('axios')).default;
    const resp = await axios.get(
      `https://payment.gst.gov.in/payment/api/challan/get/details/bycpin?cpin=${cpin}`,
      { timeout: 10000, headers: { 'Accept': 'application/json' } }
    );
    const data = resp.data;

    // Map portal status to simple string
    // Portal statuses: INITIATED, PAID, PENDING, FAILED, EXPIRED, etc.
    const portalStatus: string = (data?.challanStatus || data?.status || 'UNKNOWN').toUpperCase();
    const paid = ['PAID', 'SUCCESS', 'CLEARED'].includes(portalStatus);
    const failed = ['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(portalStatus);

    res.json({
      cpin,
      status: paid ? 'PAID' : failed ? 'FAILED' : 'PENDING',
      portalStatus,
      raw: data,
    });
  } catch (err: any) {
    // Portal may 401/403 for unauthenticated status check — return PENDING
    res.json({ cpin, status: 'PENDING', message: 'Status check unavailable — check GST portal.' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GST Challan Microservice`);
  console.log(`   Port   : ${PORT}`);
  console.log(`   Health : http://localhost:${PORT}/health`);
  console.log(`   CORS   : ${CORS_ORIGIN}`);
  console.log(`   Profiles: ${PROFILES_DIR}\n`);
});

export default app;
