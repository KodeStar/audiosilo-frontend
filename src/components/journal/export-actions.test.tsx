import { fireEvent, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { mountWithPortal } from '@/testing/render-overlay';

import { ExportActions } from './export-actions';

const setOS = (os: typeof Platform.OS) =>
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
const original = Platform.OS;
afterEach(() => setOS(original));

const mount = (props: Partial<Parameters<typeof ExportActions>[0]> = {}) => {
  const onRun = jest.fn();
  return mountWithPortal(
    <ExportActions compact={false} disabled={false} preparing={null} onRun={onRun} {...props} />,
  ).then(() => onRun);
};

describe('ExportActions', () => {
  it('native: one Export menu that shares Markdown or CSV', async () => {
    setOS('ios');
    const onRun = await mount();
    expect(screen.queryByText('Copy as Markdown')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Export the journal'));
    await fireEvent.press(await screen.findByText('Share as Markdown'));
    expect(onRun).toHaveBeenCalledWith('md', 'save');
  });

  it('web: Copy as Markdown beside a Download menu', async () => {
    setOS('web');
    const onRun = await mount();
    await fireEvent.press(screen.getByText('Copy as Markdown'));
    expect(onRun).toHaveBeenCalledWith('md', 'copy');
    await fireEvent.press(screen.getByLabelText('Export the journal'));
    expect(await screen.findByText('Download Markdown')).toBeTruthy();
    expect(screen.getByText('Download CSV')).toBeTruthy();
  });

  it('web, narrow: everything in the one menu', async () => {
    setOS('web');
    await mount({ compact: true });
    expect(screen.queryByText('Copy as Markdown')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Export the journal'));
    expect(await screen.findByText('Copy as Markdown')).toBeTruthy();
  });

  it('counts the rows while an export gathers them', async () => {
    setOS('ios');
    await mount({ preparing: 1200 });
    expect(screen.getByText('Gathering 1,200 entries')).toBeTruthy();
  });
});
