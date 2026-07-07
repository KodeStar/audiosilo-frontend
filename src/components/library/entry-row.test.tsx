import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { FsEntry } from '@/api/types';

// Link (asChild) just renders its child so the pressable mounts; navigation isn't
// under test here.
jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const mockMutate = jest.fn();
let mockFavourites: { library_id: number; path: string }[] = [];
jest.mock('@/api/hooks', () => ({
  useFavourites: () => ({ data: mockFavourites }),
  useToggleFavourite: () => ({ mutate: mockMutate }),
}));

/* eslint-disable import/first */
import { EntryRow } from './entry-row';
/* eslint-enable import/first */

const dir: FsEntry = {
  name: 'Brandon Sanderson',
  path: 'Brandon Sanderson',
  is_dir: true,
  is_audio: false,
  size: 0,
  mod_time: 0,
};
const file: FsEntry = {
  name: 'Chapter 1.mp3',
  path: 'Book/Chapter 1.mp3',
  is_dir: false,
  is_audio: true,
  size: 1000,
  mod_time: 0,
  duration: 120,
};

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

beforeEach(() => {
  mockMutate.mockClear();
  mockFavourites = [];
});

describe('EntryRow', () => {
  it('renders a folder entry with the add-to-favourites affordance', async () => {
    await mount(<EntryRow entry={dir} connectionId="c1" libraryId={1} />);
    expect(screen.getByText('Brandon Sanderson')).toBeTruthy();
    expect(screen.getByLabelText('Add to favourites')).toBeTruthy();
  });

  it('renders a file entry and toggles the favourite on press', async () => {
    await mount(<EntryRow entry={file} connectionId="c1" libraryId={1} />);
    expect(screen.getByText('Chapter 1.mp3')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Add to favourites'));
    expect(mockMutate).toHaveBeenCalledWith({ libraryId: 1, path: 'Book/Chapter 1.mp3', on: true });
  });

  it('shows the remove label when the entry is already a favourite', async () => {
    mockFavourites = [{ library_id: 1, path: 'Brandon Sanderson' }];
    await mount(<EntryRow entry={dir} connectionId="c1" libraryId={1} />);
    expect(screen.getByLabelText('Remove from favourites')).toBeTruthy();
  });
});
