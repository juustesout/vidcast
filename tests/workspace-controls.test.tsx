import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyPanel, Field, InfoMiniCard, SelectField, TabButton } from '@/components/project/workspace-controls';

describe('workspace-controls primitives', () => {
  it('renders a tab button label and toggles the active styling', () => {
    const active = renderToStaticMarkup(React.createElement(TabButton, { active: true, onClick: () => {}, children: 'Scenes' }));
    const inactive = renderToStaticMarkup(React.createElement(TabButton, { active: false, onClick: () => {}, children: 'Assets' }));

    expect(active).toContain('Scenes');
    expect(active).toContain('border-amber-300/50');
    expect(inactive).toContain('Assets');
    expect(inactive).toContain('border-slate-700/70');
    expect(inactive).not.toContain('border-amber-300/50');
  });

  it('renders an info mini card with label and value', () => {
    const html = renderToStaticMarkup(React.createElement(InfoMiniCard, { label: 'Scenes', value: '3' }));

    expect(html).toContain('Scenes');
    expect(html).toContain('3');
  });

  it('renders an empty panel message', () => {
    const html = renderToStaticMarkup(React.createElement(EmptyPanel, { message: 'No scene selected.' }));

    expect(html).toContain('No scene selected.');
  });

  it('renders a text field with its label', () => {
    const html = renderToStaticMarkup(
      React.createElement(Field, { label: 'Voice ID', value: 'voice-1', onChange: () => {} })
    );

    expect(html).toContain('Voice ID');
    expect(html).toContain('value="voice-1"');
    expect(html).toContain('type="text"');
  });

  it('renders a numeric field and a textarea variant', () => {
    const numeric = renderToStaticMarkup(
      React.createElement(Field, { label: 'Duration', value: 12, type: 'number', onChange: () => {} })
    );
    const textarea = renderToStaticMarkup(
      React.createElement(Field, { label: 'Prompt', value: 'a prompt', asTextArea: true, onChange: () => {} })
    );

    expect(numeric).toContain('type="number"');
    expect(numeric).toContain('value="12"');
    expect(textarea).toContain('<textarea');
    expect(textarea).toContain('a prompt');
  });

  it('renders a suggestion datalist when suggestions are provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(Field, {
        label: 'Model',
        value: '',
        suggestions: ['minimax/h3-max-turbo/text-to-video'],
        onChange: () => {}
      })
    );

    expect(html).toContain('<datalist');
    expect(html).toContain('minimax/h3-max-turbo/text-to-video');
  });

  it('renders select options with optional display labels', () => {
    const html = renderToStaticMarkup(
      React.createElement(SelectField, {
        label: 'Provider',
        value: 'fal',
        options: ['local', 'fal'],
        labels: { fal: 'FAL' },
        onChange: () => {}
      })
    );

    expect(html).toContain('Provider');
    expect(html).toContain('value="local"');
    expect(html).toContain('value="fal"');
    expect(html).toContain('FAL');
  });
});
