import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import italian from './locales/it.json';
import pt from './locales/pt.json';

const LOCALES = { en, de, es, fr, it: italian, pt };

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
});
