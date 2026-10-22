import fs from 'node:fs/promises';

export const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/lib/chromium/chromium'
];

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findChromiumPath(): Promise<string | undefined> {
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (candidate && await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
