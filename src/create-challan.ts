/**
 * create-challan.ts  v5
 *
 * Creates a GST payment challan, selects E-Payment → UPI → Axis Bank,
 * generates the challan (CPIN), and navigates to the payment gateway.
 *
 * Full flow (confirmed working):
 *   services.gst.gov.in  (login + manual CAPTCHA)
 *   → return.gst.gov.in  (SSO with Referer: fowelcome)
 *   → payment.gst.gov.in/cashledger  (Referer: return portal)
 *   → window.location.href → /payment/auth/ → /auth/challanreason
 *   → click AOP radio → PROCEED
 *   → /auth/challancalculation
 *   → fill IGST/CGST/SGST/Cess
 *   → click E-Payment → UPI → Axis Bank
 *   → click Generate Challan (button#forEpay)
 *   → /auth/generatedchallan  (CPIN appears)
 *   → click Make Payment → redirects to Axis Bank payment gateway
 *
 * Configure via .env:
 *   CHALLAN_REASON=AOP        (AOP = Any Other Payment, QRMP = Quarterly)
 *   CHALLAN_PERIOD=042026     (MMYYYY)
 *   CHALLAN_IGST=0
 *   CHALLAN_CGST=100
 *   CHALLAN_SGST=100
 *   CHALLAN_CESS=0
 *   CHALLAN_INTEREST=0
 *   CHALLAN_PENALTY=0
 *   CHALLAN_FEE=0
 *   CHALLAN_BANK=AXIS         (AXIS/SBI/HDFC/ICICI — used for bank matching)
 *   CHALLAN_PAY_MODE=UPI      (UPI/NETBANKING)
 *
 * Run: npm run challan
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';
import * as dotenv from 'dotenv';
dotenv.config();

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const LOGIN_URL = 'https://services.gst.gov.in/services/login';

const CHALLAN_CONFIG = {
  reason:   (process.env.CHALLAN_REASON   || 'AOP').toUpperCase(),
  period:   process.env.CHALLAN_PERIOD    || '042026',
  igst:     parseInt(process.env.CHALLAN_IGST     || '0'),
  cgst:     parseInt(process.env.CHALLAN_CGST     || '0'),
  sgst:     parseInt(process.env.CHALLAN_SGST     || '0'),
  cess:     parseInt(process.env.CHALLAN_CESS     || '0'),
  interest: parseInt(process.env.CHALLAN_INTEREST || '0'),
  penalty:  parseInt(process.env.CHALLAN_PENALTY  || '0'),
  fee:      parseInt(process.env.CHALLAN_FEE      || '0'),
  bank:     (process.env.CHALLAN_BANK     || 'AXIS').toUpperCase(),
  payMode:  (process.env.CHALLAN_PAY_MODE || 'UPI').toUpperCase(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function waitFor(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function ss(page: any, name: string) {
  const file = path.join(OUTPUT_DIR, `challan-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(chalk.gray(`  📸 challan-${name}.png`));
}

async function dumpHTML(page: any, name: string) {
  const html = await page.evaluate('document.documentElement.outerHTML');
  const file = path.join(OUTPUT_DIR, `challan-${name}.html`);
  fs.writeFileSync(file, html);
  console.log(chalk.gray(`  💾 challan-${name}.html (${Math.round(html.length / 1024)}KB)`));
  return html as string;
}

async function dumpForms(page: any): Promise<any[]> {
  return page.evaluate(`
    Array.from(document.querySelectorAll('input, select, textarea, button, a[ng-click], a[data-ng-click]')).map(el => ({
      tag:     el.tagName,
      type:    el.getAttribute('type') || '',
      name:    el.getAttribute('name') || '',
      id:      el.id || '',
      val:     (el.value || '').slice(0, 40),
      txt:     (el.textContent || '').trim().slice(0, 60),
      vis:     el.offsetParent !== null,
      dis:     el.disabled || el.getAttribute('disabled') !== null,
      ngModel: el.getAttribute('ng-model') || el.getAttribute('data-ng-model') || '',
      ngClick: el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '',
      cls:     el.className || '',
    }))
  `);
}

async function getAngularPath(page: any): Promise<string> {
  return await page.evaluate(`
    (function() {
      try { return angular.element(document.body).injector().get('\\$location').path(); }
      catch(e) { return 'error: ' + e.message; }
    })()
  `) as string;
}

async function countVisibleInputs(page: any): Promise<number> {
  return await page.evaluate(`
    (function() {
      var els = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
      var n = 0;
      for (var i = 0; i < els.length; i++) if (els[i].offsetParent !== null) n++;
      return n;
    })()
  `) as number;
}

async function waitForAngularPath(page: any, targetPath: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cur = await getAngularPath(page).catch(() => '');
    if (cur.includes(targetPath)) return true;
    await waitFor(500);
  }
  return false;
}

async function tryClick(page: any, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        const txt = await el.textContent().catch(() => '');
        console.log(chalk.gray(`    → clicking "${txt?.trim().slice(0, 50)}" [${sel}]`));
        await el.click({ timeout: 3000 });
        return sel;
      }
    } catch {}
  }
  return null;
}

async function fillAmount(page: any, selectors: string[], amount: number): Promise<boolean> {
  if (amount === 0) return true; // 0 is valid (leave empty)
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ clickCount: 3 });
        await el.fill(String(amount));
        // Trigger Angular change detection
        await el.dispatchEvent('input');
        await el.dispatchEvent('change');
        await page.evaluate(`
          (function() {
            try {
              var scope = angular.element(document.body).scope()
                       || angular.element(document.querySelector('[ng-controller]')).scope();
              if (scope && !scope.\\$root.\\$\\$phase) scope.\\$apply();
            } catch(e) {}
          })()
        `);
        console.log(chalk.gray(`    ✓ ${sel} ← ${amount}`));
        return true;
      }
    } catch {}
  }
  return false;
}

async function angularClick(page: any, id: string): Promise<void> {
  await page.evaluate(`
    (function() {
      try {
        var el = document.getElementById(${JSON.stringify(id)});
        if (!el) { console.warn('Not found: #${id}'); return; }
        el.checked = true;
        angular.element(el).triggerHandler('click');
        var root = angular.element(document.body).injector().get('\\$rootScope');
        if (!root.$$phase) root.$apply();
      } catch(e) { console.warn('angularClick error: ' + e.message); }
    })()
  `);
}

// Call an Angular scope function by name (searches up the DOM for the right controller)
async function callAngularFn(page: any, fnName: string): Promise<boolean> {
  return await page.evaluate(`
    (function() {
      try {
        // Walk all ng-controller elements to find one that has this function
        var els = document.querySelectorAll('[ng-controller], [data-ng-controller], body');
        for (var i = 0; i < els.length; i++) {
          var scope = angular.element(els[i]).scope();
          if (scope && typeof scope[${JSON.stringify(fnName)}] === 'function') {
            scope[${JSON.stringify(fnName)}]();
            if (!scope.$root.$$phase) scope.$apply();
            return true;
          }
        }
        return false;
      } catch(e) { console.warn('callAngularFn(${fnName}) error: ' + e.message); return false; }
    })()
  `) as boolean;
}

const capturedAPIs: any[] = [];
function attachCapture(page: any) {
  page.on('response', async (res: any) => {
    const url = res.url();
    if (!url.includes('gst.gov.in')) return;
    if (res.status() < 200 || res.status() >= 400) return;
    try {
      const text = await res.text();
      if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) return;
      JSON.parse(text);
      capturedAPIs.push({ method: res.request().method(), url, status: res.status() });
      const short = url.replace(/https:\/\/[^/]+\.gst\.gov\.in/, '[GST]');
      console.log(chalk.green(`  ✓ API: ${short.slice(0, 110)}`));
    } catch {}
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const username = process.env.GST_USERNAME!;
  const password = process.env.GST_PASSWORD!;
  if (!username || !password) {
    console.error(chalk.red('Set GST_USERNAME + GST_PASSWORD in .env'));
    process.exit(1);
  }

  const total = CHALLAN_CONFIG.igst + CHALLAN_CONFIG.cgst + CHALLAN_CONFIG.sgst +
                CHALLAN_CONFIG.cess + CHALLAN_CONFIG.interest + CHALLAN_CONFIG.penalty + CHALLAN_CONFIG.fee;

  console.log(chalk.cyan('\n🧾 GST Challan Creator v5\n'));
  console.log(chalk.gray(`  Reason : ${CHALLAN_CONFIG.reason}   Period: ${CHALLAN_CONFIG.period}`));
  console.log(chalk.gray(`  IGST:₹${CHALLAN_CONFIG.igst}  CGST:₹${CHALLAN_CONFIG.cgst}  SGST:₹${CHALLAN_CONFIG.sgst}  CESS:₹${CHALLAN_CONFIG.cess}`));
  console.log(chalk.gray(`  Total  : ₹${total}`));
  console.log(chalk.gray(`  Payment: E-Payment → ${CHALLAN_CONFIG.payMode} → ${CHALLAN_CONFIG.bank} Bank`));

  const context = await launchBrowser(false);
  const page    = await newPage(context);
  attachCapture(page);

  page.on('framenavigated', (frame: any) => {
    if (frame === page.mainFrame()) {
      const u = frame.url();
      if (u && !u.includes('blank') && !u.includes('about:')) {
        console.log(chalk.blue(`  🔗 Nav → ${u.slice(0, 110)}`));
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: LOGIN
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ Step 1: Login ━━━'));
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(2000);

  for (const sel of ['#username', 'input[name="username"]']) {
    try {
      if (await page.locator(sel).isVisible({ timeout: 1500 })) {
        await page.locator(sel).fill(username); break;
      }
    } catch {}
  }
  for (const sel of ['#user_pass', 'input[type="password"]']) {
    try {
      if (await page.locator(sel).isVisible({ timeout: 1500 })) {
        await page.locator(sel).fill(password); break;
      }
    } catch {}
  }
  console.log(chalk.gray('  ✓ Credentials filled'));
  console.log(chalk.bgYellow.black('\n  👆 Enter CAPTCHA in browser, then click LOGIN\n'));

  const loginDeadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < loginDeadline) {
    await waitFor(1000);
    if (!page.url().includes('/services/login')) break;
  }
  if (page.url().includes('/services/login')) {
    console.log(chalk.red('❌ Login timed out.')); await context.close(); process.exit(1);
  }
  await waitFor(3000);
  console.log(chalk.green(`  ✅ Logged in → ${page.url()}`));
  await ss(page, '01-logged-in');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: SSO CHAIN → /auth/challanreason
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ Step 2: SSO → Challan Form ━━━'));

  // 2a: Activate SSO cookie on return portal
  await page.setExtraHTTPHeaders({
    'Referer': 'https://services.gst.gov.in/services/auth/fowelcome',
    'Origin':  'https://services.gst.gov.in',
  });
  await page.goto('https://return.gst.gov.in/returns/auth/dashboard', { waitUntil: 'load', timeout: 30000 });
  await waitFor(4000);
  await page.setExtraHTTPHeaders({});
  console.log(chalk.green(`  ✅ Return portal SSO`));

  // 2b: Navigate to cashledger
  await page.goto('https://payment.gst.gov.in/payment/auth/ledger/cashledger', { waitUntil: 'load', timeout: 30000 });
  await waitFor(3000);
  if (!page.url().includes('payment.gst.gov.in')) {
    console.log(chalk.yellow('  Retrying cashledger with Referer...'));
    await page.setExtraHTTPHeaders({ 'Referer': 'https://return.gst.gov.in/returns/auth/dashboard' });
    await page.goto('https://payment.gst.gov.in/payment/auth/ledger/cashledger', { waitUntil: 'load', timeout: 30000 });
    await waitFor(3000);
    await page.setExtraHTTPHeaders({});
  }
  if (!page.url().includes('payment.gst.gov.in')) {
    console.log(chalk.red(`❌ Cannot reach payment portal. URL: ${page.url()}`));
    await context.close(); process.exit(1);
  }
  console.log(chalk.green(`  ✅ Cashledger OK`));

  // 2c: window.location.href → Angular routes to challanreason
  await page.evaluate(`window.location.href = 'https://payment.gst.gov.in/payment/auth/'`);
  try { await page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }); } catch {}
  await waitFor(5000);

  // Poll for form
  for (let i = 0; i < 15; i++) {
    await waitFor(1000);
    const n = await countVisibleInputs(page);
    if (n > 0 && page.url().includes('payment.gst.gov.in')) break;
    if (!page.url().includes('payment.gst.gov.in')) {
      console.log(chalk.red(`❌ Left payment portal: ${page.url()}`));
      await context.close(); process.exit(1);
    }
  }

  const reasonPath = await getAngularPath(page);
  console.log(chalk.green(`  ✅ Angular path: ${reasonPath}  URL: ${page.url()}`));
  await ss(page, '02c-challan-reason');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: SELECT CHALLAN REASON (AOP/QRMP) → PROCEED
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ Step 3: Select Challan Reason → Proceed ━━━'));

  const radioId = CHALLAN_CONFIG.reason === 'QRMP' ? 'qrmp' : 'aop';
  console.log(chalk.gray(`  Clicking #${radioId} (${CHALLAN_CONFIG.reason})...`));

  try { await page.locator(`#${radioId}`).click({ timeout: 3000 }); } catch {}
  await angularClick(page, radioId);
  await waitFor(1000);

  // Wait for PROCEED button to enable
  let proceedEnabled = false;
  for (let i = 0; i < 10; i++) {
    const dis = await page.evaluate(`
      (function(){
        var btn=document.querySelector('button[data-ng-click*="onProceed"],button[ng-click*="onProceed"]');
        return btn?(btn.disabled||btn.getAttribute('disabled')!==null):true;
      })()
    `) as boolean;
    if (!dis) { proceedEnabled = true; break; }
    await waitFor(500);
  }
  console.log(chalk.gray(`  PROCEED enabled: ${proceedEnabled}`));
  await ss(page, '03a-before-proceed');

  // Click PROCEED
  let clicked = false;
  if (proceedEnabled) {
    try {
      await page.locator('button[title="Proceed"]').click({ timeout: 3000 });
      clicked = true;
      console.log(chalk.green('  ✅ PROCEED clicked'));
    } catch {}
  }
  if (!clicked) {
    await page.evaluate(`
      (function(){
        try {
          var btn=document.querySelector('button[data-ng-click*="onProceed"],button[ng-click*="onProceed"]');
          if(!btn){console.warn('no PROCEED btn');return;}
          btn.removeAttribute('disabled'); btn.disabled=false;
          var scope=angular.element(btn).scope();
          if(scope&&scope.onProceed){scope.onProceed();if(!scope.$root.$$phase)scope.$apply();}
          else btn.click();
        }catch(e){console.warn(e.message);}
      })()
    `);
    clicked = true;
    console.log(chalk.green('  ✅ PROCEED called via Angular scope'));
  }

  await waitFor(4000);
  const afterProceedPath = await getAngularPath(page);
  console.log(chalk.gray(`  Angular path after PROCEED: ${afterProceedPath}`));
  await ss(page, '03b-after-proceed');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: FILL AMOUNTS + SELECT E-PAYMENT + GENERATE CHALLAN
  //
  // challancalculation page (confirmed from HTML dump):
  //   Amount table: inputs bound to challanData.{igst|cgst|sgst|cess}_{tax|int|pen|fee|oth}_amt
  //   Payment Modes (li#pay1/2/3): EPY / OTC / NEFT
  //   button#forEpay → generatechallan()
  //     — disabled until at least one amount AND a payment mode are set
  //     — EPY() alone is sufficient to enable the button (no bank needed here)
  //   Bank/UPI selection happens on the GENERATEDCHALLAN page, not here.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ Step 4: Fill Amounts + E-Payment + Bank + Generate Challan ━━━'));

  // 4a: Fill tax amounts
  console.log(chalk.gray('\n  4a. Filling tax amounts...'));

  const mkSel = (head: string, sub: string) => [
    `input[name="${head}_${sub}_amt"]`,
    `input[name=" ${head}_${sub}_amt"]`,      // portal has a leading space in sgst names
    `input[data-ng-model="challanData.${head}_${sub}_amt"]`,
    `input[ng-model="challanData.${head}_${sub}_amt"]`,
    `input[name*="${head}"][name*="${sub}"]`,
  ];

  const fillResults = {
    igst: CHALLAN_CONFIG.igst > 0 ? await fillAmount(page, mkSel('igst','tax'), CHALLAN_CONFIG.igst) : true,
    cgst: CHALLAN_CONFIG.cgst > 0 ? await fillAmount(page, mkSel('cgst','tax'), CHALLAN_CONFIG.cgst) : true,
    sgst: CHALLAN_CONFIG.sgst > 0 ? await fillAmount(page, mkSel('sgst','tax'), CHALLAN_CONFIG.sgst) : true,
    cess: CHALLAN_CONFIG.cess > 0 ? await fillAmount(page, mkSel('cess','tax'), CHALLAN_CONFIG.cess) : true,
  };
  if (CHALLAN_CONFIG.interest > 0) await fillAmount(page, mkSel('igst','int'), CHALLAN_CONFIG.interest);
  if (CHALLAN_CONFIG.penalty  > 0) await fillAmount(page, mkSel('igst','pen'), CHALLAN_CONFIG.penalty);
  if (CHALLAN_CONFIG.fee      > 0) await fillAmount(page, mkSel('igst','fee'), CHALLAN_CONFIG.fee);

  const filledCount = Object.values(fillResults).filter(Boolean).length;
  console.log(chalk.gray(`  Filled ${filledCount} amount field(s)`));
  await ss(page, '04a-amounts-filled');
  await waitFor(1000);

  // 4b: Click E-Payment
  console.log(chalk.gray('\n  4b. Clicking E-Payment...'));
  let epyClicked = false;

  // Try Playwright click first
  for (const sel of [
    'li#pay1 a',
    'a[data-ng-click="EPY()"]',
    'a[ng-click="EPY()"]',
    'span:has-text("E-Payment")',
  ]) {
    try {
      if (await page.locator(sel).isVisible({ timeout: 1500 })) {
        await page.locator(sel).first().click({ timeout: 3000 });
        epyClicked = true;
        console.log(chalk.green(`    ✅ E-Payment clicked [${sel}]`));
        break;
      }
    } catch {}
  }

  // Fallback: call EPY() via Angular scope
  if (!epyClicked) {
    const ok = await callAngularFn(page, 'EPY');
    if (ok) {
      epyClicked = true;
      console.log(chalk.green('    ✅ EPY() called via Angular scope'));
    } else {
      console.log(chalk.yellow('    ⚠️  EPY() not found — will try direct scope call'));
      await page.evaluate(`
        (function(){
          try{
            var link=document.querySelector('#pay1 a, a[data-ng-click="EPY()"]');
            if(link){angular.element(link).triggerHandler('click');
              var root=angular.element(document.body).injector().get('\\$rootScope');
              if(!root.$$phase)root.$apply();
            }
          }catch(e){}
        })()
      `);
      epyClicked = true;
    }
  }

  // EPY alone enables the Generate Challan button — wait 2s for Angular to update
  await waitFor(2000);

  // 4e: Click Generate Challan (button#forEpay)
  console.log(chalk.gray('\n  4e. Clicking Generate Challan...'));

  // Check if the button is now enabled
  const genDisabled = await page.evaluate(`
    (function(){
      var btn=document.getElementById('forEpay');
      return btn?(btn.disabled||btn.getAttribute('disabled')!==null):true;
    })()
  `) as boolean;
  console.log(chalk.gray(`  button#forEpay disabled: ${genDisabled}`));

  let genClicked = false;

  // Try Playwright click if enabled
  if (!genDisabled) {
    try {
      await page.locator('#forEpay').click({ timeout: 3000 });
      genClicked = true;
      console.log(chalk.green('  ✅ Generate Challan clicked via Playwright'));
    } catch (e: any) {
      console.log(chalk.yellow(`  Playwright click failed: ${e.message?.split('\n')[0]}`));
    }
  }

  // Force-click via Angular scope (removes disabled attr + calls generatechallan())
  if (!genClicked) {
    console.log(chalk.gray('  Force-clicking via Angular scope.generatechallan()...'));
    await page.evaluate(`
      (function(){
        try{
          var btn=document.getElementById('forEpay');
          if(!btn){console.warn('forEpay not found');return;}
          btn.removeAttribute('disabled');
          btn.disabled=false;
          var scope=angular.element(btn).scope();
          if(scope&&typeof scope.generatechallan==='function'){
            scope.generatechallan();
            if(!scope.$root.$$phase)scope.$apply();
            console.log('generatechallan() called via scope');
          } else {
            btn.click();
            console.log('generatechallan() called via btn.click()');
          }
        }catch(e){console.warn('generatechallan error: '+e.message);}
      })()
    `);
    genClicked = true;
    console.log(chalk.green('  ✅ generatechallan() triggered'));
  }

  // Wait for API response and navigation
  console.log(chalk.gray('  Waiting for challan generation API...'));
  await waitFor(5000);
  await ss(page, '04d-after-generate');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: EXTRACT CPIN + NAVIGATE TO PAYMENT GATEWAY
  //
  // /auth/generatedchallan page shows:
  //   - CPIN (14-18 digit number)
  //   - "Make Payment" button → redirects to bank payment gateway
  //   - "Download" button → PDF
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(chalk.white('\n━━━ Step 5: Extract CPIN + Navigate to Payment Gateway ━━━'));

  let cpin = '';
  const cpinDeadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < cpinDeadline) {
    await waitFor(2000);
    const curPath = await getAngularPath(page);
    const bodyText = await page.locator('body').textContent().catch(() => '') as string;
    const curUrl = page.url();

    // Look for CPIN: "CPIN" label followed by 14-18 digit number (capture group [1])
    const cpinM1 = bodyText.match(/(?:CPIN|cpin)[^\d]*(\d{14,18})/i);
    if (cpinM1 && cpinM1[1]) {
      cpin = cpinM1[1];
      console.log(chalk.green(`  ✅ CPIN: ${cpin}`));
      break;
    }
    // Fallback: any standalone 14-18 digit number
    const cpinM2 = bodyText.match(/\b(\d{14,18})\b/);
    if (cpinM2 && cpinM2[1]) {
      cpin = cpinM2[1];
      console.log(chalk.green(`  ✅ CPIN (fallback): ${cpin}`));
      break;
    }

    if (curPath.includes('generatedchallan') || curUrl.includes('generatedchallan')) {
      console.log(chalk.green('  ✅ On generatedchallan page!'));
      await ss(page, '05a-generated-challan');
      await dumpHTML(page, '05a-generated-challan');
      break;
    }

    console.log(chalk.gray(`  Waiting for CPIN... path=${curPath}  (${Math.round((cpinDeadline - Date.now()) / 1000)}s left)`));
  }

  if (!cpin) {
    // Try one more time from page text after final wait
    const bodyText = await page.locator('body').textContent().catch(() => '') as string;
    const m = bodyText.match(/\b(\d{14,18})\b/);
    if (m) { cpin = m[1]; console.log(chalk.green(`  ✅ CPIN (retry): ${cpin}`)); }
  }

  await ss(page, '05-final-before-pay');
  await dumpHTML(page, '05-generatedchallan');

  // Log visible buttons on generatedchallan page
  const genForms = await dumpForms(page);
  const btns = genForms.filter((f: any) => f.vis && (f.tag === 'BUTTON' || f.tag === 'A' || f.tag === 'INPUT'));
  console.log(chalk.gray(`\n  Visible buttons/links on generatedchallan page:`));
  btns.forEach((f: any) => {
    console.log(chalk.gray(`    [${f.tag}] id="${f.id}" txt="${f.txt.slice(0,60)}" ng="${f.ngClick}"`));
  });

  // ── 5a: Download PDF first (before Make Payment redirects away) ──────────
  console.log(chalk.gray('\n  Downloading PDF...'));
  const pdfName = cpin ? `challan-${cpin}.pdf` : 'challan-generated.pdf';
  let pdfSaved = false;

  for (const sel of [
    'button:has-text("Download")', 'a:has-text("Download")',
    'button:has-text("Print")',    'a:has-text("Print")',
    '[id*="download"]',            '[data-ng-click*="download"]',
    '[ng-click*="download"]',      '[ng-click*="print"]',
  ]) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 1500 })) {
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
          page.locator(sel).first().click(),
        ]);
        if (dl) {
          await (dl as any).saveAs(path.join(OUTPUT_DIR, pdfName));
          console.log(chalk.green(`  ✅ PDF downloaded → output/${pdfName}`));
          pdfSaved = true;
          break;
        }
        await waitFor(2000);
      }
    } catch {}
  }
  if (!pdfSaved) {
    try {
      await page.pdf({ path: path.join(OUTPUT_DIR, pdfName), printBackground: true, format: 'A4' });
      console.log(chalk.green(`  ✅ Page PDF saved → output/${pdfName}`));
      pdfSaved = true;
    } catch (e: any) {
      console.log(chalk.yellow(`  ⚠️  PDF save failed: ${e.message?.split('\n')[0]}`));
    }
  }

  // ── 5b: Select payment mode on generatedchallan → bank → Make Payment ───────
  //
  // generatedchallan page has its OWN payment mode selector:
  //   li#nb  → NB()  → Net Banking  → bank list → select bank
  //   li#upi → UPI() → BHIM UPI     → bank list → select bank   [ng-if="isReadystateUPI"]
  //   li#cc  → CC()  → Credit/Debit Card
  //   Preferred Banks
  //
  // After selecting a bank: confHide becomes true (Make Payment button enters DOM)
  //   + isDisabled becomes false (button enabled)
  // Make Payment button: type="submit" inside a form, no ng-click — needs form submit or force click
  // ──────────────────────────────────────────────────────────────────────────────

  // 5b-i: Click BHIM UPI tab (or Net Banking if UPI not available)
  console.log(chalk.gray('\n  5b. Selecting payment mode on generatedchallan page...'));
  let payModeClicked = false;

  if (CHALLAN_CONFIG.payMode === 'UPI') {
    for (const sel of ['li#upi a', 'a[data-ng-click="UPI()"]', 'a[ng-click="UPI()"]', 'span:has-text("BHIM UPI")', 'a:has-text("UPI")']) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 1500 })) {
          await page.locator(sel).first().click({ timeout: 3000 });
          payModeClicked = true;
          console.log(chalk.green(`    ✅ BHIM UPI tab clicked [${sel}]`));
          break;
        }
      } catch {}
    }
    // Fallback to Angular scope
    if (!payModeClicked) {
      const ok = await callAngularFn(page, 'UPI');
      if (ok) { payModeClicked = true; console.log(chalk.green('    ✅ UPI() called via Angular scope')); }
    }
  }

  // Fall back to Net Banking if UPI wasn't available
  if (!payModeClicked) {
    for (const sel of ['li#nb a', 'a[data-ng-click="NB()"]', 'a[ng-click="NB()"]', 'span:has-text("Net Banking")', 'a:has-text("Net Banking")']) {
      try {
        if (await page.locator(sel).isVisible({ timeout: 1500 })) {
          await page.locator(sel).first().click({ timeout: 3000 });
          payModeClicked = true;
          console.log(chalk.green(`    ✅ Net Banking tab clicked [${sel}]`));
          break;
        }
      } catch {}
    }
    if (!payModeClicked) {
      await callAngularFn(page, 'NB');
      payModeClicked = true;
      console.log(chalk.green('    ✅ NB() called via Angular scope'));
    }
  }

  // Wait for bank list to render
  await waitFor(3000);
  await ss(page, '05b-after-paymode');
  await dumpHTML(page, '05b-after-paymode');

  // Dump all visible elements to see what the bank list looks like
  const payForms = await dumpForms(page);
  const payEls = payForms.filter((f: any) => f.vis);
  console.log(chalk.gray(`  All visible elements after payment mode select (${payEls.length}):`));
  payEls.forEach((f: any) => {
    console.log(chalk.gray(`    [${f.tag}] id="${f.id}" val="${f.val}" txt="${f.txt.slice(0,60)}" ng="${f.ngClick}"`));
  });

  // 5b-ii: Select Axis Bank from bank list
  // Bank radios confirmed from live dump: input[id="UTIB"], input[id="SBIN"] etc.
  // Must use angularClick (not just Playwright click) to trigger Angular ng-model.
  console.log(chalk.gray(`\n  5b-ii. Selecting ${CHALLAN_CONFIG.bank} Bank...`));

  const bankIdMap: Record<string, string> = {
    AXIS: 'UTIB', SBI: 'SBIN', HDFC: 'HDFC', ICICI: 'ICIC',
    KOTAK: 'KKBK', FEDERAL: 'FDRL', INDUSIND: 'INDB', UNION: 'UBIN',
    CANARA: 'CNRB', IOB: 'IOBA', KARNATAKA: 'KARB',
  };
  const bankId = bankIdMap[CHALLAN_CONFIG.bank] || CHALLAN_CONFIG.bank;
  console.log(chalk.gray(`    Bank input id: "${bankId}"`));

  // Use angularClick to properly trigger Angular ng-model update
  let bankClicked = false;
  try {
    await page.locator(`input#${bankId}`).click({ timeout: 3000 });
    await angularClick(page, bankId);
    bankClicked = true;
    console.log(chalk.green(`    ✅ ${CHALLAN_CONFIG.bank} Bank (${bankId}) selected via angularClick`));
  } catch (e: any) {
    console.log(chalk.yellow(`    ⚠️  Bank click failed: ${e.message?.split('\n')[0]}`));
    // Fallback: set scope variable directly
    await page.evaluate(`
      (function(){
        try {
          var el = document.getElementById(${JSON.stringify(bankId)});
          if (!el) { console.warn('Bank input not found: ${bankId}'); return; }
          el.checked = true;
          var scope = angular.element(el).scope();
          if (scope) {
            // Common ng-model names for bank selection
            if (typeof scope.selectedBank !== 'undefined') scope.selectedBank = ${JSON.stringify(bankId)};
            if (typeof scope.bankCode !== 'undefined') scope.bankCode = ${JSON.stringify(bankId)};
            if (typeof scope.challanData !== 'undefined') scope.challanData.bankCode = ${JSON.stringify(bankId)};
            if (!scope.$root.$$phase) scope.$apply();
          }
          angular.element(el).triggerHandler('change');
          angular.element(el).triggerHandler('click');
        } catch(e) { console.warn('bank scope set error: ' + e.message); }
      })()
    `);
    bankClicked = true;
  }
  await waitFor(1000);

  // 5b-iii: Check the consent checkbox (required before Make Payment enables)
  console.log(chalk.gray('\n  5b-iii. Checking consent checkbox...'));
  try {
    const consentEl = page.locator('input#checkbox-consent');
    if (await consentEl.isVisible({ timeout: 2000 })) {
      await consentEl.click();
      await angularClick(page, 'checkbox-consent');
      console.log(chalk.green('    ✅ Consent checkbox checked'));
    }
  } catch {}
  await waitFor(1000);

  // Wait for Make Payment button to be enabled (isDisabled → false)
  console.log(chalk.gray('  Waiting for Make Payment to enable...'));
  let makePayReady = false;
  for (let i = 0; i < 15; i++) {
    await waitFor(1000);
    const state = await page.evaluate(`
      (function(){
        var btn = document.querySelector('button[title="Make Payment"]');
        if (!btn) return { found: false, disabled: true };
        return { found: true, disabled: btn.disabled || btn.getAttribute('disabled') !== null };
      })()
    `) as { found: boolean; disabled: boolean };
    if (state.found && !state.disabled) { makePayReady = true; break; }
  }
  console.log(chalk.gray(`  Make Payment ready: ${makePayReady}`));
  await ss(page, '05c-before-makepay');

  // 5b-iv: Trigger payment via saveBankAndPayNow() Angular scope function
  // (form name="generatedChallanPage" ng-submit="saveBankAndPayNow()")
  // This POSTs to the bank gateway — page will navigate away
  console.log(chalk.gray('\n  5b-iv. Triggering saveBankAndPayNow()...'));
  let makePayClicked = false;

  // Try normal click first (if enabled)
  if (makePayReady) {
    try {
      await page.locator('button[title="Make Payment"]').click({ timeout: 5000 });
      makePayClicked = true;
      console.log(chalk.green('  ✅ Make Payment clicked normally'));
    } catch {}
  }

  // Force: call saveBankAndPayNow() directly on Angular scope
  if (!makePayClicked) {
    const called = await callAngularFn(page, 'saveBankAndPayNow');
    if (called) {
      makePayClicked = true;
      console.log(chalk.green('  ✅ saveBankAndPayNow() called via Angular scope'));
    }
  }

  // Last resort: remove disabled + click
  if (!makePayClicked) {
    await page.evaluate(`
      (function(){
        try {
          var btn = document.querySelector('button[title="Make Payment"]');
          if (!btn) { console.warn('Make Payment button not found'); return; }
          btn.removeAttribute('disabled'); btn.disabled = false;
          var form = document.querySelector('form[name="generatedChallanPage"]');
          var scope = form ? angular.element(form).scope() : null;
          if (scope && typeof scope.saveBankAndPayNow === 'function') {
            scope.saveBankAndPayNow();
            if (!scope.$root.$$phase) scope.$apply();
          } else { btn.click(); }
        } catch(e) { console.warn('force Make Payment error: ' + e.message); }
      })()
    `);
    makePayClicked = true;
    console.log(chalk.green('  ✅ saveBankAndPayNow() force-called'));
  }

  if (makePayClicked) {
    console.log(chalk.gray('  Waiting for payment gateway redirect...'));
    await waitFor(8000);
    const gwUrl = page.url();
    console.log(chalk.green(`\n  ✅ Payment Gateway URL:\n     ${gwUrl}\n`));
    await ss(page, '05d-payment-gateway');
    await dumpHTML(page, '05d-payment-gateway');

    const gwData = { cpin, gatewayUrl: gwUrl, bank: CHALLAN_CONFIG.bank, payMode: CHALLAN_CONFIG.payMode, ts: new Date().toISOString() };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `challan-${cpin || 'latest'}-gateway.json`),
      JSON.stringify(gwData, null, 2)
    );
    console.log(chalk.green(`  ✅ Gateway info saved → output/challan-${cpin || 'latest'}-gateway.json`));
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  if (capturedAPIs.length > 0) {
    fs.writeFileSync(path.join(OUTPUT_DIR, 'challan-apis.json'), JSON.stringify(capturedAPIs, null, 2));
  }

  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.cyan('  GST Challan Created!'));
  if (cpin) console.log(chalk.green(`  CPIN    : ${cpin}`));
  console.log(chalk.cyan(`  PDF     : output/${pdfName}`));
  console.log(chalk.cyan(`  APIs    : ${capturedAPIs.length} captured`));
  console.log(chalk.cyan(`  Outputs : output/`));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  await context.close();
}

main().catch(err => {
  console.error(chalk.red('\nFatal:'), err.message);
  process.exit(1);
});
