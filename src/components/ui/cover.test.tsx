import { render, screen } from '@testing-library/react-native';

import { clothColor } from '@/lib/monogram';

import { Cover, MONOGRAM_MAX_SIZE } from './cover';

describe('Cover fallback', () => {
  it('shows the title and author on a cover big enough to hold them', async () => {
    await render(<Cover label="Blood Rites" sublabel="Jim Butcher" size={MONOGRAM_MAX_SIZE} />);
    expect(screen.getByText('Blood Rites')).toBeTruthy();
    expect(screen.getByText('Jim Butcher')).toBeTruthy();
    expect(screen.queryByTestId('cover-monogram')).toBeNull();
  });

  it('keeps the title fallback when the size comes from the layout', async () => {
    await render(<Cover label="Blood Rites" sublabel="Jim Butcher" />);
    expect(screen.getByText('Blood Rites')).toBeTruthy();
  });

  it('shows the initials on the cloth colour below the threshold, never clipped text', async () => {
    await render(<Cover label="Blood Rites" sublabel="Jim Butcher" size={48} />);
    const mono = screen.getByTestId('cover-monogram', { includeHiddenElements: true });
    expect(mono.props.style).toEqual(
      expect.objectContaining({ backgroundColor: clothColor('Blood Rites') }),
    );
    expect(screen.getByText('BR', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText('Blood Rites')).toBeNull();
    expect(screen.queryByText('Jim Butcher')).toBeNull();
  });

  it('leaves a small cover with no title blank', async () => {
    await render(<Cover size={36} />);
    expect(screen.queryByTestId('cover-monogram')).toBeNull();
  });
});
