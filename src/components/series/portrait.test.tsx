import { render, screen } from '@testing-library/react-native';

import { portraitColors } from './people-model';
import { Portrait, RING_ROOM } from './portrait';

// A portrait is hidden from screen readers, so every query includes hidden elements.
const hidden = { includeHiddenElements: true } as const;
/** The rendered tree minus React's per-instance gradient id. */
const drawn = () => JSON.stringify(screen.toJSON()).replace(/pt-[A-Za-z0-9_-]+/g, 'pt');

describe('Portrait', () => {
  it('draws the initials on two hues that always follow the name', async () => {
    const sam = portraitColors('sam', 'user');
    expect(sam.from).not.toBe(sam.to);

    await render(<Portrait name="sam" kind="user" size={38} />);
    expect(screen.getByText('S', hidden)).toBeTruthy();
    const first = drawn();
    await render(<Portrait name="sam" kind="user" size={38} />);
    expect(drawn()).toBe(first);

    await render(<Portrait name="Maya Hart" kind="user" size={38} />);
    expect(screen.getByText('MH', hidden)).toBeTruthy();
    expect(portraitColors('Maya Hart', 'user')).not.toEqual(sam);
  });

  it('rings who is listening in room of its own, so a ring never moves the layout', async () => {
    await render(<Portrait name="sam" kind="user" size={38} />);
    expect(screen.queryByTestId('portrait-ringed', hidden)).toBeNull();

    await render(<Portrait name="sam" kind="user" size={38} ring={false} />);
    expect(screen.queryByTestId('portrait-ring', hidden)).toBeNull();
    const room = screen.getByTestId('portrait-ringed', hidden).props.style;

    await render(<Portrait name="sam" kind="user" size={38} ring />);
    expect(screen.getByTestId('portrait-ring', hidden)).toBeTruthy();
    expect(screen.getByTestId('portrait-ringed', hidden).props.style).toEqual(room);
    expect(room).toEqual({ margin: RING_ROOM });
  });

  it('is hidden from screen readers (the name is always written beside it)', async () => {
    await render(<Portrait name="sam" kind="user" size={38} ring />);
    expect(screen.queryByText('S')).toBeNull();
    const ringed = screen.getByTestId('portrait-ringed', hidden);
    expect(ringed.props.accessibilityElementsHidden).toBe(true);
    expect(ringed.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});
