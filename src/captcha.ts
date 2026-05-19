/**
 * captcha.ts
 *
 * Solves the GST portal image CAPTCHA automatically.
 *
 * GST portal uses a simple distorted-text image CAPTCHA.
 * We screenshot the CAPTCHA element → send to solver API → get text back.
 *
 * Providers:
 *   2captcha    → https://2captcha.com  (~$3/1000, human solvers, ~15s)
 *   capmonster  → https://capmonster.cloud (~$0.5/1000, AI, ~5s)
 *
 * Set CAPTCHA_PROVIDER + CAPTCHA_API_KEY in .env
 */

import axios from 'axios';
import { Page } from 'playwright';
import chalk from 'chalk';
import * as dotenv from 'dotenv';
dotenv.config();

const PROVIDER = process.env.CAPTCHA_PROVIDER || '2captcha';
const API_KEY   = process.env.CAPTCHA_API_KEY || '';

if (!API_KEY) {
  console.warn(chalk.yellow('⚠️  CAPTCHA_API_KEY not set in .env — captcha solving will fail'));
}

/**
 * Finds the CAPTCHA image on the page, screenshots it,
 * sends to solver, returns the solved text.
 */
export async function solveCaptcha(page: Page): Promise<string> {
  console.log(chalk.gray('  🔍 Locating CAPTCHA image...'));

  // Try common CAPTCHA selectors on GST portal
  const selectors = [
    'img[src*="captcha"]',
    'img[id*="captcha"]',
    'img[class*="captcha"]',
    '#imgCaptcha',
    '.captchaimg',
    'canvas[id*="captcha"]',
  ];

  let captchaElement = null;
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        captchaElement = el;
        console.log(chalk.gray(`  ✓ Found CAPTCHA at selector: ${sel}`));
        break;
      }
    } catch {}
  }

  if (!captchaElement) {
    // Fallback: try to find by looking at all images
    console.log(chalk.yellow('  ⚠️  Standard selectors failed. Scanning all images...'));
    const allImages = page.locator('img');
    const count = await allImages.count();
    for (let i = 0; i < count; i++) {
      const img = allImages.nth(i);
      const src = await img.getAttribute('src') || '';
      if (src.toLowerCase().includes('captcha') || src.startsWith('data:image')) {
        captchaElement = img;
        console.log(chalk.gray(`  ✓ Found CAPTCHA image (scan) src=${src.substring(0, 60)}`));
        break;
      }
    }
  }

  if (!captchaElement) {
    throw new Error('Could not find CAPTCHA image on page. Check portal structure.');
  }

  // Screenshot just the CAPTCHA element
  const imageBuffer = await captchaElement.screenshot();
  const base64Image = imageBuffer.toString('base64');

  console.log(chalk.gray(`  📤 Sending to ${PROVIDER} solver...`));

  const result = PROVIDER === 'capmonster'
    ? await solveWithCapMonster(base64Image)
    : await solveWith2Captcha(base64Image);

  console.log(chalk.green(`  ✅ CAPTCHA solved: "${result}"`));
  return result;
}

// ── 2captcha solver ───────────────────────────────────────────────────────────

async function solveWith2Captcha(base64Image: string): Promise<string> {
  // Step 1: Submit CAPTCHA
  const submitRes = await axios.post('https://2captcha.com/in.php', {
    key: API_KEY,
    method: 'base64',
    body: base64Image,
    json: 1,
  });

  if (submitRes.data.status !== 1) {
    throw new Error(`2captcha submit failed: ${JSON.stringify(submitRes.data)}`);
  }

  const captchaId = submitRes.data.request;

  // Step 2: Poll for result (max 30 seconds)
  for (let i = 0; i < 10; i++) {
    await sleep(3000);

    const resultRes = await axios.get('https://2captcha.com/res.php', {
      params: { key: API_KEY, action: 'get', id: captchaId, json: 1 },
    });

    if (resultRes.data.status === 1) {
      return resultRes.data.request as string;
    }

    if (resultRes.data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha error: ${resultRes.data.request}`);
    }

    console.log(chalk.gray(`  ⏳ Waiting for solve... (${(i + 1) * 3}s)`));
  }

  throw new Error('2captcha timed out after 30s');
}

// ── CapMonster solver ─────────────────────────────────────────────────────────

async function solveWithCapMonster(base64Image: string): Promise<string> {
  // Step 1: Create task
  const createRes = await axios.post('https://api.capmonster.cloud/createTask', {
    clientKey: API_KEY,
    task: {
      type: 'ImageToTextTask',
      body: base64Image,
    },
  });

  if (createRes.data.errorId !== 0) {
    throw new Error(`CapMonster error: ${createRes.data.errorDescription}`);
  }

  const taskId = createRes.data.taskId;

  // Step 2: Poll for result
  for (let i = 0; i < 10; i++) {
    await sleep(2000);

    const resultRes = await axios.post('https://api.capmonster.cloud/getTaskResult', {
      clientKey: API_KEY,
      taskId,
    });

    if (resultRes.data.status === 'ready') {
      return resultRes.data.solution.text as string;
    }

    console.log(chalk.gray(`  ⏳ Waiting for solve... (${(i + 1) * 2}s)`));
  }

  throw new Error('CapMonster timed out after 20s');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
