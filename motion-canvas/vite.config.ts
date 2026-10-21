import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {defineConfig, Plugin} from 'vite';
import motionCanvasPlugin from '@motion-canvas/vite-plugin';
import ffmpegPlugin from '@motion-canvas/ffmpeg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const paramsFile = path.join(root, 'output', 'p102-4-params.json');

const motionCanvas =
  typeof motionCanvasPlugin === 'function'
    ? motionCanvasPlugin
    : (motionCanvasPlugin as {default: typeof motionCanvasPlugin}).default;
const ffmpeg =
  typeof ffmpegPlugin === 'function'
    ? ffmpegPlugin
    : (ffmpegPlugin as {default: typeof ffmpegPlugin}).default;

function headlessRenderPlugin(): Plugin {
  return {
    name: 'p102-headless-render',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? new URL(req.url, 'http://localhost') : null;
        if (url?.pathname === '/__params') {
          res.setHeader('Content-Type', 'application/json');
          if (fs.existsSync(paramsFile)) {
            res.end(fs.readFileSync(paramsFile, 'utf8'));
          } else {
            res.end('{}');
          }
          return;
        }
        if (url?.pathname === '/__render') {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>P102 headless render</title>
  </head>
  <body>
            <script type="module" src="/src/headless.ts?target=${url.searchParams.get('target') ?? 'proof'}"></script>
  </body>
</html>`);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    motionCanvas({
      project: [
        './src/project.ts',
        './src/project-alpha.ts',
        './src/project-overlay.ts',
        './src/project-chart.ts',
      ],
      output: './output',
    }),
    ffmpeg(),
    headlessRenderPlugin(),
  ],
  server: {
    host: true,
    port: 9000,
    allowedHosts: ['.monkeycode-ai.live'],
  },
});
