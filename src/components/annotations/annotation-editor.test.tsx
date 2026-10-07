import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Bookmark, Chapter, Note } from '@/api/types';

let mockAnnotations: boolean | undefined = true;
const mockAdd = jest.fn();
const mockUpdate = jest.fn();
const mockAddNote = jest.fn();
const mockUpdateNote = jest.fn();
const mockChapters: { chapters: Chapter[]; files: never[] } = { chapters: [], files: [] };
jest.mock('@/api/hooks', () => ({
  CapabilityError: class CapabilityError extends Error {},
  useCapability: () => mockAnnotations,
  useAddBookmark: () => ({ mutate: mockAdd, isPending: false }),
  useUpdateBookmark: () => ({ mutate: mockUpdate, isPending: false }),
  useAddNote: () => ({ mutate: mockAddNote, isPending: false }),
  useUpdateNote: () => ({ mutate: mockUpdateNote, isPending: false }),
  useChapters: () => ({ data: mockChapters }),
}));
let mockConnected = true;
jest.mock('@/api/provider', () => ({ useOptionalApi: () => (mockConnected ? {} : null) }));
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { toast } from '@/components/ui/toast';
import type { EditorRequest } from '@/lib/annotation-request';

import { AnnotationEditor } from './annotation-editor';
/* eslint-enable import/first */

const target = { connectionId: 'c', libraryId: 1, path: 'a/book' };

const chapter = (index: number, title: string, bookOffset: number): Chapter => ({
  index,
  title,
  file_index: 0,
  file_path: 'a.m4b',
  start: bookOffset,
  end: bookOffset + 10_000,
  book_offset: bookOffset,
});

const bookmark: Bookmark = {
  id: 7,
  library_id: 1,
  path: 'a/book',
  position: 62_810,
  note: 'Bridge Four',
  label: 'favourite',
  created_at: '2026-10-01T10:00:00Z',
};

const note: Note = {
  id: 9,
  library_id: 1,
  path: 'a/book',
  position: 37_200,
  body: 'Theory',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
};

const onDone = jest.fn();
const open = (request: EditorRequest) =>
  render(<AnnotationEditor request={request} onDone={onDone} />);

beforeEach(() => {
  jest.clearAllMocks();
  mockAnnotations = true;
  mockConnected = true;
  mockChapters.chapters = [];
});

describe('the bookmark editor', () => {
  it('shows where it lands: the time and the chapter', async () => {
    mockChapters.chapters = [chapter(0, 'Prologue', 0), chapter(1, 'Bridge Four', 60_000)];
    await open({ kind: 'bookmark', target, position: 62_810 });
    expect(screen.getByLabelText('17:26:50')).toBeTruthy();
    expect(screen.getByText('Bridge Four')).toBeTruthy();
  });

  it('makes a bookmark with a note and a label on a server with annotations', async () => {
    await open({ kind: 'bookmark', target, position: 62_810 });
    await fireEvent.changeText(screen.getByTestId('bookmark-note'), 'Life before death.');
    await fireEvent.press(screen.getByRole('radio', { name: 'Quote' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark 17:26:50' }));
    expect(mockAdd).toHaveBeenCalledWith(
      { position: 62_810, note: 'Life before death.', label: 'quote' },
      expect.anything(),
    );
    mockAdd.mock.calls[0][1].onSuccess();
    expect(onDone).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ title: 'Bookmark added', description: '17:26:50' });
  });

  it('offers the note only on a server without annotations, and never sends a label', async () => {
    mockAnnotations = false;
    await open({ kind: 'bookmark', target, position: 62_810 });
    expect(screen.queryByRole('radio')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('bookmark-note'), 'A note');
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark 17:26:50' }));
    expect(mockAdd).toHaveBeenCalledWith({ position: 62_810, note: 'A note' }, expect.anything());
  });

  it('edits only what changed', async () => {
    await open({ kind: 'bookmark', target, position: 62_810, bookmark });
    expect(screen.getByRole('radio', { name: 'Favourite' })).toBeChecked();
    // Tapping the chosen label again clears it.
    await fireEvent.press(screen.getByRole('radio', { name: 'Favourite' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark' }));
    expect(mockUpdate).toHaveBeenCalledWith({ id: 7, label: '' }, expect.anything());
    mockUpdate.mock.calls[0][1].onSuccess();
    expect(toast).toHaveBeenCalledWith({ title: 'Bookmark saved', description: '17:26:50' });
  });

  it('closes on Save without a change, sending nothing', async () => {
    await open({ kind: 'bookmark', target, position: 62_810, bookmark });
    await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark' }));
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('says why an edit cannot be saved on an older server', async () => {
    mockAnnotations = false;
    await open({ kind: 'bookmark', target, position: 62_810, bookmark });
    expect(screen.getByText('Editing needs a newer AudioSilo server.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save bookmark' })).toBeDisabled();
  });

  it('keeps the sheet open and says so when the save fails', async () => {
    await open({ kind: 'bookmark', target, position: 62_810, bookmark });
    await fireEvent.changeText(screen.getByTestId('bookmark-note'), 'New');
    await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark' }));
    mockUpdate.mock.calls[0][1].onError(new Error('offline'));
    expect(onDone).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ title: "Couldn't save the bookmark" });
  });

  it('says so when the book’s server is not connected', async () => {
    mockConnected = false;
    await open({ kind: 'bookmark', target, position: 62_810 });
    expect(screen.getByText("This book's server isn't connected")).toBeTruthy();
  });
});

describe('the note editor', () => {
  it('pins a new note at the place, once it has a body', async () => {
    mockAnnotations = false; // adding a note works on every server
    await open({ kind: 'note', target, position: 37_200 });
    expect(screen.getByLabelText('10:20:00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pin note' })).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('note-body'), ' Syl is **not** a windspren ');
    await fireEvent.press(screen.getByRole('button', { name: 'Pin note' }));
    expect(mockAddNote).toHaveBeenCalledWith(
      { body: 'Syl is **not** a windspren', position: 37_200 },
      expect.anything(),
    );
    mockAddNote.mock.calls[0][1].onSuccess();
    expect(toast).toHaveBeenCalledWith({ title: 'Note pinned at 10:20:00' });
  });

  it('edits the body and keeps the place', async () => {
    await open({ kind: 'note', target, position: 37_200, note });
    await fireEvent.changeText(screen.getByTestId('note-body'), 'A better theory');
    await fireEvent.press(screen.getByRole('button', { name: 'Save note' }));
    expect(mockUpdateNote).toHaveBeenCalledWith(
      { id: 9, body: 'A better theory' },
      expect.anything(),
    );
  });
});
