import { render, screen } from '@testing-library/react-native';

import { portraitColors } from '@/components/series/people-model';

import { PersonAvatar } from './person-avatar';

// The avatar is hidden from screen readers, so every query includes hidden elements.
const hidden = { includeHiddenElements: true } as const;
/** The rendered tree minus React's per-instance gradient id. */
const drawn = () => JSON.stringify(screen.toJSON()).replace(/pa-[A-Za-z0-9_-]+/g, 'pa');

describe('PersonAvatar', () => {
  it('draws the initials on two hues that always follow the name', async () => {
    const sam = portraitColors('sam', 'user');
    expect(sam.from).not.toBe(sam.to);

    await render(<PersonAvatar name="sam" size={38} />);
    expect(screen.getByText('S', hidden)).toBeTruthy();
    const first = drawn();
    await render(<PersonAvatar name="sam" size={38} />);
    expect(drawn()).toBe(first);

    await render(<PersonAvatar name="Maya Hart" size={38} />);
    expect(screen.getByText('MH', hidden)).toBeTruthy();
    expect(portraitColors('Maya Hart', 'user')).not.toEqual(sam);
  });

  it('rings who is listening on this device without changing its size', async () => {
    await render(<PersonAvatar name="sam" size={38} />);
    expect(screen.queryByTestId('person-avatar-ring', hidden)).toBeNull();

    await render(<PersonAvatar name="sam" size={38} ring />);
    expect(screen.getByTestId('person-avatar-ring', hidden)).toBeTruthy();
    expect(screen.getByTestId('person-avatar', hidden).props.style).toEqual({
      width: 38,
      height: 38,
    });
  });

  it('is hidden from screen readers (the name is always written beside it)', async () => {
    await render(<PersonAvatar name="sam" size={38} />);
    expect(screen.queryByText('S')).toBeNull();
    const avatar = screen.getByTestId('person-avatar', hidden);
    expect(avatar.props.accessibilityElementsHidden).toBe(true);
    expect(avatar.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});
