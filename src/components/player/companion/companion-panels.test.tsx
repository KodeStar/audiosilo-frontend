import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';

import type { BookMetaCharacter, BookMetaRecap } from '@/api/types';

jest.mock('@/api/hooks', () => ({ useMetaWork: () => ({ data: undefined, isError: false }) }));
// CoverFrame's iOS shadow hook reads the theme provider, whose module imports
// global.css (unparseable in Node).
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockOpenUrl = jest.fn();
jest.mock('@/lib/support', () => ({ openExternalUrl: (u: string) => mockOpenUrl(u) }));

/* eslint-disable import/first */
import { useCompanion } from './companion-store';
import { StoryPanel } from './story-panel';
import type { CompanionData } from './use-companion-data';
import { WhoPanel } from './who-panel';
/* eslint-enable import/first */

// The book page's fixture shape (book-meta.render.test): a cast across the book and
// position-keyed recaps.
const characters: BookMetaCharacter[] = [
  {
    id: 'bilbo',
    name: 'Bilbo Baggins',
    role: 'protagonist',
    reveal: { chapter: 1 },
    description: 'A hobbit.',
  },
  {
    id: 'gollum',
    name: 'Gollum',
    role: 'antagonist',
    reveal: { chapter: 5 },
    aliases: ['Smeagol'],
  },
  { id: 'smaug', name: 'Smaug', role: 'antagonist', reveal: { chapter: 12 } },
];
const recaps: BookMetaRecap[] = [
  { through: { chapter: 0 }, scope: 'series', text: 'Prior books.' },
  { through: { chapter: 6 }, scope: 'book', text: 'So far, riddles.' },
  { through: { chapter: 13 }, scope: 'book', text: 'The dragon wakes.' },
];
const attribution = {
  credit: 'AudioSilo Meta community contributors',
  license: 'CC BY-SA 4.0',
  license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  source_url: 'https://meta.audiosilo.app/work?id=the-hobbit',
};

const data = (over: Partial<CompanionData> = {}): CompanionData => ({
  target: { connectionId: 'a', libraryId: 1, path: 'Tolkien/The Hobbit' },
  key: 'a:1:Tolkien/The Hobbit',
  status: 'ready',
  characters,
  recaps,
  summary: { in_short: 'The whole book, ending included.' },
  attribution,
  metaKnown: true,
  listening: { chapter: 7, finished: false },
  ...over,
});

async function mount(ui: ReactElement) {
  await act(async () => {
    render(ui);
  });
}
async function press(text: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(text));
  });
}

beforeEach(() => {
  useCompanion.setState({ tab: null, revealedKey: null, justMet: null });
  mockOpenUrl.mockClear();
});

describe("Who's who", () => {
  it('shows the people met so far, newest first, and counts the rest without naming them', async () => {
    await mount(<WhoPanel data={data()} />);
    const names = screen.getAllByText(/^(Bilbo Baggins|Gollum)$/).map((n) => n.props.children);
    expect(names).toEqual(['Gollum', 'Bilbo Baggins']);
    expect(screen.queryByText('Smaug')).toBeNull();
    expect(screen.getByText("1 character you haven't met yet is hidden")).toBeTruthy();
    expect(screen.getByText("2 people you've met")).toBeTruthy();
    expect(screen.getByText('Also Smeagol')).toBeTruthy();
    expect(screen.getByText('From chapter 5')).toBeTruthy();
  });

  it('keeps a description behind its own tap (it is written for the whole book)', async () => {
    await mount(<WhoPanel data={data()} />);
    expect(screen.queryByText('A hobbit.')).toBeNull();
    await press('Bilbo Baggins');
    expect(screen.getByText('A hobbit.')).toBeTruthy();
  });

  it('reveals on Show anyway, marked, and hides them again', async () => {
    await mount(<WhoPanel data={data()} />);
    await press('Show anyway');
    expect(screen.getByText('Smaug')).toBeTruthy();
    expect(screen.getByText('Spoilers shown')).toBeTruthy();
    expect(screen.getByText('Spoiler')).toBeTruthy();
    await press('Hide them again');
    expect(screen.queryByText('Smaug')).toBeNull();
  });

  it('marks the people a crossing just revealed', async () => {
    useCompanion.getState().markJustMet('a:1:Tolkien/The Hobbit', ['gollum']);
    await mount(<WhoPanel data={data()} />);
    expect(screen.getByText('Just met')).toBeTruthy();
  });

  it('says so kindly when the book has no community notes, and nothing while loading', async () => {
    await mount(<WhoPanel data={data({ status: 'none', characters: [] })} />);
    expect(screen.getByText('No character notes for this book yet')).toBeTruthy();
  });

  it('renders nothing while loading or on a server without metadata', async () => {
    await mount(
      <>
        <WhoPanel data={data({ status: 'loading' })} />
        <StoryPanel data={data({ status: 'off' })} />
      </>,
    );
    expect(screen.toJSON()).toBeNull();
  });

  it("ends with the server's licence line, linking the licence", async () => {
    await mount(<WhoPanel data={data()} />);
    expect(
      screen.getByText('Community notes from AudioSilo Meta community contributors'),
    ).toBeTruthy();
    await press('CC BY-SA 4.0');
    expect(mockOpenUrl).toHaveBeenCalledWith(attribution.license_url);
  });
});

describe('Story so far', () => {
  it('stops at the last recap the listener is past', async () => {
    await mount(<StoryPanel data={data()} />);
    expect(screen.getByText('Up to chapter 6')).toBeTruthy();
    expect(screen.getByText('Prior books.')).toBeTruthy();
    expect(screen.getByText('So far, riddles.')).toBeTruthy();
    expect(screen.queryByText('The dragon wakes.')).toBeNull();
    expect(screen.getByText('1 more part of the story is hidden')).toBeTruthy();
  });

  it('keeps the whole-book summary behind its spoiler row while the book is unfinished', async () => {
    await mount(<StoryPanel data={data()} />);
    expect(screen.queryByText('The whole book, ending included.')).toBeNull();
    await press('Whole-book summary');
    expect(screen.getByText('The whole book, ending included.')).toBeTruthy();
  });

  it("shares Who's who's reveal: shown there, shown here", async () => {
    await mount(<WhoPanel data={data()} />);
    await press('Show anyway');
    await mount(<StoryPanel data={data()} />);
    expect(screen.getByText('The dragon wakes.')).toBeTruthy();
  });

  it('starts hidden again for another book', async () => {
    useCompanion.getState().setRevealed('a:1:Another', true);
    await mount(<StoryPanel data={data()} />);
    expect(screen.queryByText('The dragon wakes.')).toBeNull();
  });

  it('says so kindly when there is no recap', async () => {
    await mount(<StoryPanel data={data({ recaps: [], summary: undefined })} />);
    expect(screen.getByText('No recap for this book yet')).toBeTruthy();
  });
});

// Characters and recaps generated on this server (Bridge Phase 1a): each panel marks its
// own dimension only, and an empty panel carries the admin's generate slot under its note.
describe('generated content in the companion', () => {
  it("marks Who's who only when the characters were generated here", async () => {
    await mount(<WhoPanel data={data({ generated: { characters: true } })} />);
    expect(screen.getByText('Generated on this server')).toBeTruthy();
  });

  it('marks Story so far only when the recaps were generated here', async () => {
    await mount(<StoryPanel data={data({ generated: { characters: true } })} />);
    expect(screen.queryByText('Generated on this server')).toBeNull();
    await mount(<StoryPanel data={data({ generated: { recaps: true } })} />);
    expect(screen.getByText('Generated on this server')).toBeTruthy();
  });

  it('never marks community content', async () => {
    await mount(<WhoPanel data={data()} />);
    expect(screen.queryByText('Generated on this server')).toBeNull();
  });

  // A matched work keeps its community credit for what the community wrote; the
  // dimension generated here carries none of it.
  it('credits the community only under its own content', async () => {
    await mount(<WhoPanel data={data({ generated: { characters: true } })} />);
    expect(screen.queryByText(/Community notes from/)).toBeNull();
    await mount(<StoryPanel data={data({ generated: { characters: true } })} />);
    expect(screen.getByText(/Community notes from/)).toBeTruthy();
    await mount(<StoryPanel data={data({ generated: { recaps: true } })} />);
    expect(screen.queryByText(/Community notes from/)).toBeNull();
  });

  it('puts the generate slot under an empty panel only', async () => {
    const slot = <Text>generate slot</Text>;
    await mount(<WhoPanel data={data({ status: 'none' })} generate={slot} />);
    expect(screen.getByText('generate slot')).toBeTruthy();
    await mount(<StoryPanel data={data({ status: 'none' })} generate={slot} />);
    expect(screen.getByText('generate slot')).toBeTruthy();
    await mount(<WhoPanel data={data()} generate={slot} />);
    expect(screen.queryByText('generate slot')).toBeNull();
  });
});
