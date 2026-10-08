import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, type View } from 'react-native';

import i18n from '@/i18n';

jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));

/* eslint-disable import/first */
import { StoryStage } from './story-stage';
import type { StoryPlayer } from './use-story-player';
import { cardCopy } from './year-copy';
import { yearStats } from './year-fixture';
import { buildYearCards } from './year-model';
/* eslint-enable import/first */

const cards = buildYearCards({
  stats: yearStats(),
  current: false,
  currentStreak: null,
  goal: null,
});
const copies = cards.map((c) =>
  cardCopy(c, { year: '2026', userName: 'alex', serverName: 'Hearthside' }, i18n.t),
);

function player(index = 0): StoryPlayer {
  return {
    index,
    goTo: jest.fn(),
    next: jest.fn(),
    previous: jest.fn(),
    progress: { value: 0.5 } as StoryPlayer['progress'],
  };
}

async function mount(p: StoryPlayer, opts: { screenReader?: boolean; onHold?: jest.Mock } = {}) {
  const props = {
    cards,
    copies,
    width: 360,
    connectionId: 'a',
    cardRef: { current: null as View | null },
    plainCovers: false,
    screenReader: opts.screenReader ?? false,
    onHold: opts.onHold ?? jest.fn(),
  };
  const view = await render(<StoryStage {...props} player={p} />);
  return { ...view, props };
}

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('StoryStage', () => {
  it('reads the card out whole on native, "Card N of M" first', async () => {
    await mount(player(1));
    expect(
      screen.getByLabelText(
        'Card 2 of 8. Books finished. 41 books finished. Each spine is a book you finished.',
      ),
    ).toBeTruthy();
  });

  it('names the region by its place on the web, where the words are real text', async () => {
    Platform.OS = 'web';
    await mount(player(0));
    expect(screen.getByLabelText('Card 1 of 8')).toBeTruthy();
  });

  it('announces cards on the web only while the listener drives the story', async () => {
    Platform.OS = 'web';
    await mount(player(0));
    const region = () => screen.getByLabelText('Card 1 of 8');
    expect(region().props['aria-live']).toBe('off');
    await fireEvent(screen.getByRole('button', { name: 'Next card' }), 'focus');
    expect(region().props['aria-live']).toBe('polite');
  });

  it('moves with the labelled previous and next buttons', async () => {
    const p = player(3);
    await mount(p);
    await fireEvent.press(screen.getByRole('button', { name: 'Next card' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Previous card' }));
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.previous).toHaveBeenCalledTimes(1);
  });

  it('takes the arrow keys on the web, and keeps them from the player', async () => {
    Platform.OS = 'web';
    const p = player(0);
    const { toJSON } = await mount(p);
    const root = toJSON() as unknown as { props: { onKeyDown: (e: unknown) => void } };
    const stop = jest.fn();
    root.props.onKeyDown({ key: 'ArrowRight', preventDefault: jest.fn(), stopPropagation: stop });
    root.props.onKeyDown({ key: 'ArrowLeft', preventDefault: jest.fn(), stopPropagation: stop });
    root.props.onKeyDown({ key: 'Enter', preventDefault: jest.fn(), stopPropagation: stop });
    expect(p.next).toHaveBeenCalledTimes(1);
    expect(p.previous).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('holds while a finger or the pointer is on the card', async () => {
    const onHold = jest.fn();
    await mount(player(0), { onHold });
    const next = screen.getByRole('button', { name: 'Next card' });
    await fireEvent(next, 'pressIn');
    expect(onHold).toHaveBeenLastCalledWith(true);
    await fireEvent(next, 'pressOut');
    expect(onHold).toHaveBeenLastCalledWith(false);
  });

  it('holds while the pointer is over the stage, across both tap zones', async () => {
    const onHold = jest.fn();
    await mount(player(0), { onHold });
    const stage = screen.getByTestId('year-story-stage');
    await fireEvent(stage, 'pointerEnter');
    expect(onHold).toHaveBeenLastCalledWith(true);
    const calls = onHold.mock.calls.length;
    // Over the Next zone after the Previous one: still held, nothing reported.
    await fireEvent(screen.getByRole('button', { name: 'Next card' }), 'hoverIn');
    expect(onHold.mock.calls.length).toBe(calls);
    await fireEvent(stage, 'pointerLeave');
    expect(onHold).toHaveBeenLastCalledWith(false);
  });

  it('fills the current bar with a transform, not its width', async () => {
    await mount(player(0));
    const bar = screen.getByTestId('story-bar-current', { includeHiddenElements: true });
    const style = Object.assign({}, ...[bar.props.style].flat(Infinity));
    expect(style.width).toBeUndefined();
    expect(style.transformOrigin).toBe('left');
  });

  it('holds for the keyboard focus, not for the focus a click gives', async () => {
    const onHold = jest.fn();
    await mount(player(0), { onHold });
    const next = screen.getByRole('button', { name: 'Next card' });
    await fireEvent(next, 'pressIn');
    await fireEvent(next, 'focus');
    await fireEvent(next, 'pressOut');
    expect(onHold).toHaveBeenLastCalledWith(false);
    await fireEvent(next, 'blur');
    await fireEvent(next, 'focus');
    expect(onHold).toHaveBeenLastCalledWith(true);
  });

  it('announces each card a native screen reader moves to', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    const { rerender, props } = await mount(player(0), { screenReader: true });
    expect(announce).not.toHaveBeenCalled();
    await act(async () => rerender(<StoryStage {...props} player={player(1)} />));
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/^Card 2 of 8\. Books finished/));
  });
});
