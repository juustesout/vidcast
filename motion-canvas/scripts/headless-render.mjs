import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/lib/chromium/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function waitForHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, response => {
        response.resume();
        if ((response.statusCode ?? 500) < 500) {
          resolve();
          return;
        }
        retry();
      });
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(probe, 250);
    };
    probe();
  });
}

async function renderProject(browser, port, which, timeoutMs) {
  const page = await browser.newPage();
  page.on('console', msg => {
    console.log(`[browser:${which}] ${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', error => {
    console.error(`[browser:${which}] pageerror: ${error.message}`);
  });

  const url = `http://127.0.0.1:${port}/__render?target=${which}`;
  await page.goto(url, {waitUntil: 'load', timeout: timeoutMs});
  await page.waitForFunction(
    () => globalThis.__MC_RENDER_DONE === true,
    {timeout: timeoutMs},
  );
  const result = await page.evaluate(() => ({
    error: globalThis.__MC_RENDER_ERROR ?? null,
    result: globalThis.__MC_RENDER_RESULT ?? null,
  }));
  await page.close();
  if (result.error) {
    throw new Error(`${which} render failed: ${result.error}`);
  }
  if (result.result !== 0 && result.result !== null) {
    throw new Error(`${which} render finished with RendererResult=${result.result}`);
  }
}

async function main() {
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      'No Chromium/Chrome binary found for headless Motion Canvas render',
    );
  }

  const port = Number(process.env.MC_PORT ?? 9000);
  const timeoutMs = Number(process.env.MC_RENDER_TIMEOUT_MS ?? 180000);
  const which = process.argv[2] ?? 'both';

  const vite = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, BROWSER: 'none'},
    },
  );
  vite.stdout.on('data', chunk => process.stdout.write(`[vite] ${chunk}`));
  vite.stderr.on('data', chunk => process.stderr.write(`[vite] ${chunk}`));

  let viteExitedBeforeReady = false;
  const waitForExit = new Promise((resolve, reject) => {
    vite.once('exit', code => {
      viteExitedBeforeReady = true;
      if (code) {
        reject(new Error(`Vite exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });

  const stopVite = async () => {
    if (!vite.pid || vite.exitCode !== null) {
      return;
    }
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      vite.kill('SIGTERM');
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    if (vite.exitCode === null) {
      try {
        process.kill(-vite.pid, 'SIGKILL');
      } catch {
        vite.kill('SIGKILL');
      }
    }
  };

  try {
    await Promise.race([
      waitForHttp(`http://127.0.0.1:${port}/`, 60000),
      waitForExit.then(() => {
        throw new Error('Vite exited before becoming ready');
      }),
    ]);
    if (viteExitedBeforeReady) {
      throw new Error('Vite exited before becoming ready');
    }
    const puppeteer = await import('puppeteer-core');
    const browser = await puppeteer.default.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--font-render-hinting=none',
      ],
    });

    try {
      if (which === 'proof' || which === 'both') {
        await renderProject(browser, port, 'proof', timeoutMs);
      }
      if (which === 'alpha' || which === 'both') {
        await renderProject(browser, port, 'alpha', timeoutMs);
      }
      if (which === 'overlay' || which === 'both') {
        await renderProject(browser, port, 'overlay', timeoutMs);
      }
      if (which === 'chart' || which === 'both') {
        await renderProject(browser, port, 'chart', timeoutMs);
      }
    } finally {
      await browser.close();
    }
  } finally {
    await stopVite();
  }

  console.log('headless render finished');
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
