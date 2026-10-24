import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('claim form visibility', () => {
  it('mounts ClaimProjectForm on home without a session redirect', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'app/page.tsx'), 'utf8');
    expect(source).toContain("import { ClaimProjectForm } from '@/components/project/claim-project-form'");
    expect(source).toContain('<ClaimProjectForm />');
    expect(source).not.toContain("redirect(");
  });

  it('keeps ClaimProjectForm on /projects without redirecting unauthenticated visitors', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'app/projects/page.tsx'), 'utf8');
    expect(source).toContain("import { ClaimProjectForm } from '@/components/project/claim-project-form'");
    expect(source).toContain('<ClaimProjectForm />');
    expect(source).not.toContain("redirect(");
    expect(source).not.toContain("redirect('/');");
  });
});
