import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProjectWorkspace HTML still slot picker', () => {
  it('wires the picker into every supported HTML image slot and imports via the server asset id', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'components/project/project-workspace.tsx'), 'utf8');

    expect(source).toContain('function setHtmlStillSlotImage');
    expect(source).toContain('async function importHtmlStillSlotImage');
    expect(source).toContain('<HtmlStillSlotImagePicker');
    expect(source).toContain('onSelect={(assetId) => setHtmlStillSlotImage(selectedScene.id, assetId)}');
    expect(source).toContain('onSelect={(assetId) => setHtmlStillSlotImage(selectedScene.id, assetId, index)}');
    expect(source).toContain('onImport={(file) => void importHtmlStillSlotImage(selectedScene.id, file)}');
    expect(source).toContain('onImport={(file) => void importHtmlStillSlotImage(selectedScene.id, file, index)}');
    expect(source).toContain('applyHtmlStillSlotImage(scene.visual.templateData, assetId, productIndex)');
    expect(source).toContain('applyHtmlStillSlotImage(scene.visual.templateData, body.asset!.id, productIndex)');
    expect(source).toContain('if (!isHtmlStillSlotImageAsset(body.asset))');
    expect(source).not.toContain('label="Image asset id"');
    expect(source).not.toContain('label="Products (name | imageAssetId | feature:value; feature:value)"');
  });
});
