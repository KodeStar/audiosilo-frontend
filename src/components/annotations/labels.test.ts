import type { TFunction } from 'i18next';

import { PICKABLE_BOOKMARK_LABELS } from '@/api/bookmark-labels';
import i18n from '@/i18n';

import { labelText, toggleLabel } from './labels';

const t = i18n.t.bind(i18n) as TFunction;

describe('labelText', () => {
  it('names every label the player knows in the listener’s language', async () => {
    expect(labelText(t, 'quote')).toBe('Quote');
    expect(labelText(t, 'relisten')).toBe('Re-listen');
    expect(labelText(t, 'fell_asleep')).toBe('Fell asleep');
    await i18n.changeLanguage('de');
    try {
      expect(labelText(t, 'relisten')).toBe('Nochmal hören');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('names nothing for no label, an older server or a key a newer client made', () => {
    expect(labelText(t, '')).toBeNull();
    expect(labelText(t, undefined)).toBeNull();
    expect(labelText(t, 'spoiler_warning')).toBeNull();
  });
});

describe('toggleLabel', () => {
  it('picks one label or none: the chosen one again clears it', () => {
    expect(toggleLabel('', 'quote')).toBe('quote');
    expect(toggleLabel('quote', 'funny')).toBe('funny');
    expect(toggleLabel('funny', 'funny')).toBe('');
  });

  it('replaces a label the picker does not offer', () => {
    expect(PICKABLE_BOOKMARK_LABELS).not.toContain('fell_asleep');
    expect(toggleLabel('fell_asleep', 'question')).toBe('question');
    expect(toggleLabel('from_the_future', 'quote')).toBe('quote');
  });
});
