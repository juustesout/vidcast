import type { RenderPlanScene } from '@/lib/types/render';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text: string, maxChars = 28): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [''];
}

function svgHeader(width: number, height: number, background: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${background}" />
      <stop offset="100%" stop-color="#020617" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000000" flood-opacity="0.35" />
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)" />`;
}

function svgFooter(): string {
  return '</svg>';
}

function renderBodyText(width: number, height: number, title: string, subtitle?: string, accent = '#f2d17b'): string {
  const titleLines = wrapText(title, Math.max(18, Math.floor(width / 40)));
  const titleFontSize = Math.max(34, Math.floor(width / 14));
  const subtitleFontSize = Math.max(18, Math.floor(width / 36));
  const titleY = Math.max(110, Math.floor(height * 0.35));
  const lineGap = Math.floor(titleFontSize * 1.2);
  const subtitleY = titleY + titleLines.length * lineGap + 48;

  return `
  <g filter="url(#shadow)">
    ${titleLines.map((line, index) => `<text x="50%" y="${titleY + index * lineGap}" text-anchor="middle" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-size="${titleFontSize}" font-weight="700">${escapeXml(line)}</text>`).join('\n    ')}
    ${subtitle ? `<text x="50%" y="${subtitleY}" text-anchor="middle" fill="${accent}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${subtitleFontSize}" font-weight="500">${escapeXml(subtitle)}</text>` : ''}
  </g>`;
}

function renderList(width: number, height: number, items: string[]): string {
  const lineFontSize = Math.max(22, Math.floor(width / 34));
  const startY = Math.max(160, Math.floor(height * 0.34));
  return `
  <g filter="url(#shadow)">
    ${items.slice(0, 6).map((item, index) => `<text x="${Math.floor(width * 0.16)}" y="${startY + index * Math.floor(lineFontSize * 1.45)}" fill="#e2e8f0" font-family="DejaVu Sans, Arial, sans-serif" font-size="${lineFontSize}">• ${escapeXml(item)}</text>`).join('\n    ')}
  </g>`;
}

function renderStatistic(width: number, height: number, value: string, label?: string): string {
  const valueSize = Math.max(56, Math.floor(width / 10));
  const labelSize = Math.max(20, Math.floor(width / 36));
  return `
  <g filter="url(#shadow)">
    <text x="50%" y="${Math.floor(height * 0.46)}" text-anchor="middle" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-size="${valueSize}" font-weight="800">${escapeXml(value)}</text>
    ${label ? `<text x="50%" y="${Math.floor(height * 0.58)}" text-anchor="middle" fill="#93c5fd" font-family="DejaVu Sans, Arial, sans-serif" font-size="${labelSize}" font-weight="600">${escapeXml(label)}</text>` : ''}
  </g>`;
}

function renderQuote(width: number, height: number, quote: string, author?: string): string {
  const quoteLines = wrapText(quote, Math.max(20, Math.floor(width / 38)));
  const quoteSize = Math.max(28, Math.floor(width / 24));
  const authorSize = Math.max(18, Math.floor(width / 40));
  const startY = Math.max(160, Math.floor(height * 0.35));
  const lineGap = Math.floor(quoteSize * 1.45);
  return `
  <g filter="url(#shadow)">
    ${quoteLines.map((line, index) => `<text x="50%" y="${startY + index * lineGap}" text-anchor="middle" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-size="${quoteSize}" font-style="italic">${escapeXml(index === 0 ? `“${line}` : line)}${index === quoteLines.length - 1 ? '”' : ''}</text>`).join('\n    ')}
    ${author ? `<text x="50%" y="${startY + quoteLines.length * lineGap + 36}" text-anchor="middle" fill="#f2d17b" font-family="DejaVu Sans, Arial, sans-serif" font-size="${authorSize}" font-weight="600">— ${escapeXml(author)}</text>` : ''}
  </g>`;
}

function renderComparison(width: number, height: number, left: string, right: string): string {
  const cardY = Math.floor(height * 0.36);
  const cardH = Math.max(160, Math.floor(height * 0.28));
  const cardW = Math.floor(width * 0.34);
  const leftX = Math.floor(width * 0.1);
  const rightX = Math.floor(width * 0.56);
  return `
  <g filter="url(#shadow)">
    <rect x="${leftX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="28" fill="#0f172a" stroke="#334155" />
    <rect x="${rightX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="28" fill="#0f172a" stroke="#334155" />
    <text x="${leftX + cardW / 2}" y="${cardY + cardH / 2}" text-anchor="middle" fill="#e2e8f0" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.max(22, Math.floor(width / 32))}" font-weight="700">${escapeXml(left)}</text>
    <text x="${rightX + cardW / 2}" y="${cardY + cardH / 2}" text-anchor="middle" fill="#e2e8f0" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.max(22, Math.floor(width / 32))}" font-weight="700">${escapeXml(right)}</text>
  </g>`;
}

function renderCallout(width: number, height: number, text: string): string {
  const lines = wrapText(text, Math.max(20, Math.floor(width / 30)));
  const boxW = Math.floor(width * 0.72);
  const boxH = Math.max(150, Math.floor(lines.length * 52 + 70));
  const x = Math.floor((width - boxW) / 2);
  const y = Math.floor((height - boxH) / 2);
  return `
  <g filter="url(#shadow)">
    <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="32" fill="#111827" stroke="#f2d17b" stroke-width="4" />
    ${lines.map((line, index) => `<text x="50%" y="${y + 56 + index * 48}" text-anchor="middle" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-size="${Math.max(24, Math.floor(width / 28))}" font-weight="600">${escapeXml(line)}</text>`).join('\n    ')}
  </g>`;
}

function renderEndCard(width: number, height: number, text: string): string {
  return renderBodyText(width, height, text, 'Thanks for watching', '#dbeafe');
}

export function createStillSceneSvg(scene: RenderPlanScene, width: number, height: number, background = '#020617'): string {
  const base = svgHeader(width, height, background);
  const visual = scene.source;
  const overlayText = scene.overlay && scene.overlay.type !== 'none' ? scene.overlay.text ?? '' : '';
  const text = scene.source.text ?? overlayText;

  if (visual.kind === 'blank') {
    return `${base}\n  <rect width="100%" height="100%" fill="${background}" />\n${svgFooter()}`;
  }

  if (visual.kind === 'text') {
    const body = renderBodyText(width, height, text || 'Text scene');
    return `${base}${body}\n${svgFooter()}`;
  }

  if (visual.kind === 'graphic') {
    const template = visual.template ?? 'simple_diagram';
    const data = visual.templateData ?? {};
    if (template === 'title_card') {
      const title = typeof data.title === 'string' ? data.title : text || 'Title card';
      const subtitle = typeof data.subtitle === 'string' ? data.subtitle : undefined;
      return `${base}${renderBodyText(width, height, title, subtitle)}\n${svgFooter()}`;
    }
    if (template === 'bullet_list') {
      const title = typeof data.title === 'string' ? data.title : text || 'Bullet list';
      const items = Array.isArray(data.items) ? data.items.filter((item): item is string => typeof item === 'string') : [];
      return `${base}${renderBodyText(width, height, title)}${renderList(width, height, items.length > 0 ? items : ['First point', 'Second point', 'Third point'])}\n${svgFooter()}`;
    }
    if (template === 'statistic') {
      const value = typeof data.value === 'string' ? data.value : '42%';
      const label = typeof data.label === 'string' ? data.label : text || 'Statistic';
      return `${base}${renderStatistic(width, height, value, label)}\n${svgFooter()}`;
    }
    if (template === 'quote') {
      const quote = typeof data.quote === 'string' ? data.quote : text || 'Quote';
      const author = typeof data.author === 'string' ? data.author : undefined;
      return `${base}${renderQuote(width, height, quote, author)}\n${svgFooter()}`;
    }
    if (template === 'comparison') {
      const left = typeof data.left === 'string' ? data.left : 'Before';
      const right = typeof data.right === 'string' ? data.right : 'After';
      return `${base}${renderComparison(width, height, left, right)}\n${svgFooter()}`;
    }
    if (template === 'callout') {
      const callout = typeof data.text === 'string' ? data.text : text || 'Callout';
      return `${base}${renderCallout(width, height, callout)}\n${svgFooter()}`;
    }
    if (template === 'end_card') {
      const endText = typeof data.text === 'string' ? data.text : text || 'The End';
      return `${base}${renderEndCard(width, height, endText)}\n${svgFooter()}`;
    }

    const generic = typeof data.title === 'string' ? data.title : template.replace(/_/g, ' ');
    return `${base}${renderBodyText(width, height, generic, text || 'Graphic scene')}\n${svgFooter()}`;
  }

  const fallbackText = text || scene.source.kind.toUpperCase();
  return `${base}${renderBodyText(width, height, fallbackText)}\n${svgFooter()}`;
}

export function sceneMotionToZoomPan(scene: RenderPlanScene, frameCount: number): string {
  const progressDivisor = Math.max(1, frameCount - 1);
  const p = frameCount > 1 ? `on/${progressDivisor}` : '0';
  const zoomStep = scene.motion.intensity ? Math.max(0.01, Math.min(0.2, scene.motion.intensity / 10)) : 0.08;
  const centerX = 'max(0, (iw - ow/zoom)/2)';
  const centerY = 'max(0, (ih - oh/zoom)/2)';
  const rightX = 'max(0, iw - ow/zoom)';
  const bottomY = 'max(0, ih - oh/zoom)';

  switch (scene.motion.preset) {
    case 'zoom_out':
      return `z='${1 + zoomStep} - (${zoomStep}*${p})':x='${centerX}':y='${centerY}'`;
    case 'pan_left':
      return `z='1.0':x='${centerX}*(1-${p})':y='${centerY}'`;
    case 'pan_right':
      return `z='1.0':x='${centerX} + (${rightX} - ${centerX})*${p}':y='${centerY}'`;
    case 'pan_up':
      return `z='1.0':x='${centerX}':y='${centerY}*(1-${p})'`;
    case 'pan_down':
      return `z='1.0':x='${centerX}':y='${centerY} + (${bottomY} - ${centerY})*${p}'`;
    case 'zoom_left':
      return `z='1.0 + ${zoomStep}*${p}':x='${centerX}*(1-${p})':y='${centerY}'`;
    case 'zoom_right':
      return `z='1.0 + ${zoomStep}*${p}':x='${centerX} + (${rightX} - ${centerX})*${p}':y='${centerY}'`;
    case 'zoom_in':
    case 'none':
    default:
      return `z='1.0 + ${zoomStep}*${p}':x='${centerX}':y='${centerY}'`;
  }
}

export function buildSceneFadeFilters(durationSeconds: number): string[] {
  const fadeSeconds = Math.min(0.35, Math.max(0.12, durationSeconds / 10));
  if (durationSeconds <= fadeSeconds * 2) {
    return [];
  }

  return [
    `fade=t=in:st=0:d=${fadeSeconds}`,
    `fade=t=out:st=${Math.max(0, durationSeconds - fadeSeconds)}:d=${fadeSeconds}`
  ];
}
