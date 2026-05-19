/**
 * session-check.ts
 *
 * Checks if the persistent profile is still logged in.
 * Runs headlessly — if it reaches dashboard, session is alive.
 *
 * Run: npm run session:check
 */

import chalk from 'chalk';
import { launchBrowser, newPage } from './browser';

async function main() {
  console.log(chalk.cyan('\n🔍 Checking session...\n'));

  const context = await launchBrowser(true); // headless
  const page    = await newPage(context);

  try {
    await page.goto('https://return.gst.gov.in/returns/auth/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    await page.waitForTimeout(2000);
    const url   = page.url();
    const title = await page.title();

    const onLoginPage =
      url.includes('/login') ||
      url.includes('services.gst.gov.in/services/login') ||
      title.toLowerCase().includes('login');

    if (onLoginPage) {
      console.log(chalk.red('❌ Session DEAD — portal redirected to login page.'));
      console.log(chalk.yellow('\nRun: npm run login\n'));
    } else {
      console.log(chalk.green('✅ Session is ALIVE'));
      console.log(chalk.gray(`   URL:   ${url}`));
      console.log(chalk.gray(`   Title: ${title}`));

      // Try to read GSTIN from page
      try {
        const gstin = await page
          .locator('[class*="gstin"], [id*="gstin"], [data-gstin]')
          .first()
          .textContent({ timeout: 3000 });
        if (gstin?.trim()) console.log(chalk.gray(`   GSTIN: ${gstin.trim()}`));
      } catch {}

      console.log(chalk.cyan('\nReady to scrape. Run:'));
      console.log('  npm run explore         ← map all API endpoints first');
      console.log('  npm run scrape:notices  ← fetch notices');
      console.log('  npm run scrape:returns  ← fetch returns\n');
    }
  } catch (err: any) {
    console.log(chalk.red(`❌ Could not reach portal: ${err.message}`));
    console.log(chalk.yellow('Run: npm run login\n'));
  }

  await context.close();
}

main().catch(err => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
