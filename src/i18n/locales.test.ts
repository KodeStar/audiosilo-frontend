import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import italian from './locales/it.json';
import pt from './locales/pt.json';

const LOCALES = { en, de, es, fr, it: italian, pt };

/** Every leaf of a strings tree, as `dotted.key: text`. */
function leaves(tree: unknown, prefix = ''): [string, string][] {
  if (typeof tree === 'string') return [[prefix, tree]];
  if (!tree || typeof tree !== 'object') return [];
  return Object.entries(tree).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

describe('locales', () => {
  // One setting, one name: Settings and the Downloads page's rules card both name the
  // auto-download mode with downloads.rules.mode (they once said "Automatically
  // download books" and "Download automatically").
  it.each(Object.entries(LOCALES))('%s names the auto-download setting once', (_, l) => {
    expect(l.downloads.rules.mode.label).toBeTruthy();
    expect(l.downloads.rules.modeHint).toBeTruthy();
    expect('autoDownload' in l.settings.upNext).toBe(false);
  });

  // The output pill opens AirPlay (iOS, Safari) or Android's output switcher; casting has
  // its own button (src/cast). Its name must not promise Cast.
  it.each(Object.entries(LOCALES))('%s names the output pill without Cast', (_, l) => {
    expect(l.player.routePicker.label).toBeTruthy();
    expect(l.player.routePicker.label).not.toMatch(/cast|airplay/i);
  });

  // My devices' "Also sign out {{names}} on that device" (8b-1) is about the device in
  // the row, never the one in hand: de and fr once said "this device".
  it.each(Object.entries(LOCALES))('%s says THAT device when signing members out there', (_, l) => {
    expect(l.account.devices.alsoSignOut).not.toMatch(
      /this device|diesem Gerät|cet appareil(?!-là)|este dispositivo|questo dispositivo|neste dispositivo/,
    );
  });

  // Relative times where Hermes has no Intl.RelativeTimeFormat (#132): every language has
  // every form `formatRelative` asks for.
  it.each(Object.entries(LOCALES))('%s has every relative time string', (_, l) => {
    const keys = leaves(l.common.ago).map(([k]) => k);
    expect(keys).toEqual(leaves(en.common.ago).map(([k]) => k));
    expect(keys).toEqual(
      expect.arrayContaining([
        'now',
        'yesterday',
        'lastMonth',
        'lastYear',
        'hour_one',
        'day_other',
      ]),
    );
  });

  // Podcasts (Bridge 2d-1): every string in every language, including each reason an
  // episode could not be fetched (`fetchReasonKey`), and none names the Bridge or uses
  // an em dash.
  const podcastStrings = (l: typeof en) =>
    leaves({ podcasts: l.podcasts, newEpisodes: l.home.newEpisodes, shows: l.library.modes.shows });
  it.each(Object.entries(LOCALES))('%s has every podcast string', (_, l) => {
    const keys = podcastStrings(l).map(([k]) => k);
    expect(keys).toEqual(podcastStrings(en).map(([k]) => k));
    for (const reason of [
      'module_off',
      'bridge_unavailable',
      'library_not_writable',
      'fetch_limit',
      'demo_account',
      'too_large',
      'identity_changed',
      'other',
    ]) {
      expect(keys).toContain(`podcasts.fetch.reason.${reason}`);
    }
    for (const [key, text] of podcastStrings(l)) {
      expect([key, text]).toEqual([key, expect.not.stringMatching(/bridge|\u2014/i)]);
    }
  });
});
