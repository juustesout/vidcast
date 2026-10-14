import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('offline-safe fonts', () => {
  it('does not load fonts from Google at build or runtime', () => {
    const layout = fs.readFileSync(path.join(process.cwd(), 'app/layout.tsx'), 'utf8');

    expect(layout).not.toContain('next/font/google');
    expect(layout).not.toContain('next/font');
    expect(layout).not.toContain('fonts.googleapis.com');
  });

  it('defines the body, mono and display font variables locally', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8');

    expect(css).toContain('--font-body:');
    expect(css).toContain('--font-mono:');
    expect(css).toContain('--font-display:');
  });

  it('keeps the existing font assignments intact', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'app/globals.css'), 'utf8');
    const page = fs.readFileSync(path.join(process.cwd(), 'app/page.tsx'), 'utf8');

    expect(css).toContain('font-family: var(--font-body)');
    expect(page).toContain('font-[var(--font-display)]');
  });
});
