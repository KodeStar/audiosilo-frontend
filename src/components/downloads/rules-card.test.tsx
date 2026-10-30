import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

jest.mock('@/downloads/keep-ahead-controller', () => ({
  useKeepAhead: (select: (s: { status: string }) => unknown) => select({ status: 'off' }),
}));

/* eslint-disable import/first */
import { useSettings, type AutoDownloadMode } from '@/stores/settings';

import { AutoDownloadHint, RulesCard } from './rules-card';
/* eslint-enable import/first */

const WEB_WIFI = /can't tell Wi-Fi from mobile data/;
const defaultOS = Platform.OS;

afterEach(() => {
  Platform.OS = defaultOS;
});

// fe#196: the hint described On while Never (the web default) was selected.
describe('AutoDownloadHint', () => {
  it.each<[AutoDownloadMode, RegExp]>([
    ['never', /^Nothing downloads on its own/],
    ['wifi', /on Wi-Fi\.$/],
    ['always', /on any connection\.$/],
  ])('says what %s does', async (mode, words) => {
    await render(<AutoDownloadHint mode={mode} />);
    expect(screen.getByText(words)).toBeTruthy();
  });

  it("adds the browser's Wi-Fi caveat under On Wi-Fi on web only", async () => {
    Platform.OS = 'web';
    await render(<AutoDownloadHint mode="wifi" />);
    expect(screen.getByText(WEB_WIFI)).toBeTruthy();
    await render(<AutoDownloadHint mode="always" />);
    expect(screen.queryByText(WEB_WIFI)).toBeNull();
    Platform.OS = 'ios';
    await render(<AutoDownloadHint mode="wifi" />);
    expect(screen.queryByText(WEB_WIFI)).toBeNull();
  });
});

describe('RulesCard', () => {
  it("shows the chosen mode's hint", async () => {
    useSettings.getState().setAutoDownloadNext('never');
    await render(<RulesCard />);
    expect(screen.getByText(/^Nothing downloads on its own/)).toBeTruthy();
    expect(screen.queryByText(/when you start listening/)).toBeNull();
  });
});
