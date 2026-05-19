/**
 * session.ts
 * Simple file-based session persistence.
 * Stores Playwright storageState (cookies + localStorage) to disk.
 * In production this will move to Supabase encrypted.
 */

import fs from 'fs';
import path from 'path';
import { BrowserContext } from 'playwright';

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function sessionPath(portal: string = 'gst'): string {
  return path.join(SESSIONS_DIR, `${portal}-session.json`);
}

/** Save current browser context state to disk */
export async function saveSession(context: BrowserContext, portal: string = 'gst') {
  const state = await context.storageState();
  const payload = {
    state,
    savedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), // 8hr
  };
  fs.writeFileSync(sessionPath(portal), JSON.stringify(payload, null, 2));
  console.log(`✅ Session saved → sessions/${portal}-session.json`);
  console.log(`   Expires at: ${payload.expiresAt}`);
}

/** Load saved session. Returns null if not found or expired. */
export function loadSessionState(portal: string = 'gst'): any | null {
  const fp = sessionPath(portal);
  if (!fs.existsSync(fp)) {
    console.log(`⚠️  No saved session for "${portal}". Run: npm run login`);
    return null;
  }

  const payload = JSON.parse(fs.readFileSync(fp, 'utf-8'));

  if (new Date(payload.expiresAt) < new Date()) {
    console.log(`⚠️  Session expired at ${payload.expiresAt}. Run: npm run login`);
    return null;
  }

  const savedAt = new Date(payload.savedAt);
  const ageMin = Math.round((Date.now() - savedAt.getTime()) / 60000);
  console.log(`📂 Loaded session (saved ${ageMin}min ago, expires ${payload.expiresAt})`);
  return payload.state;
}

/** Check if a valid session file exists */
export function hasValidSession(portal: string = 'gst'): boolean {
  return loadSessionState(portal) !== null;
}
