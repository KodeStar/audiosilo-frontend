import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { SourcedProgress } from '@/api/hooks';

// Zero insets so the lifted Sheet doesn't need a SafeAreaProvider in the test tree.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockMutate = jest.fn();
jest.mock('@/api/hooks', () => ({
  useMarkFinished: () => ({ mutate: mockMutate }),
}));

const mockOpenLibrary = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openLibrary: mockOpenLibrary, openBook: jest.fn(), openPlayer: jest.fn() }),
}));

/* eslint-disable import/first */
import { ProgressMenuSheet } from './progress-menu-sheet';
/* eslint-enable import/first */

const item = {
  connectionId: 'c1',
  connectionName: 'Server',
  library_id: 1,
  path: 'Cosmere/Mistborn/Book 1',
  position: 100,
  duration: 1000,
  finished: false,
  playback_speed: 1,
  updated_at: '2026-01-01T00:00:00Z',
} as SourcedProgress;

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

beforeEach(() => {
  mockMutate.mockClear();
  mockOpenLibrary.mockClear();
});

describe('ProgressMenuSheet', () => {
  it('renders the menu rows when an item is set', async () => {
    await mount(<ProgressMenuSheet item={item} onClose={jest.fn()} />);
    expect(screen.getByText('Mark as Finished')).toBeTruthy();
    expect(screen.getByText('More in series')).toBeTruthy();
  });

  it('renders nothing when the item is null', async () => {
    await mount(<ProgressMenuSheet item={null} onClose={jest.fn()} />);
    expect(screen.queryByText('Mark as Finished')).toBeNull();
    expect(screen.queryByText('More in series')).toBeNull();
  });

  it('closes and marks finished when Mark as Finished is pressed', async () => {
    const onClose = jest.fn();
    await mount(<ProgressMenuSheet item={item} onClose={onClose} />);

    fireEvent.press(screen.getByText('Mark as Finished'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({
      libraryId: item.library_id,
      path: item.path,
      position: item.position,
      duration: item.duration,
      playback_speed: item.playback_speed,
    });
  });
});
