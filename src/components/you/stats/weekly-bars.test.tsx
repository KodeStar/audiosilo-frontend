import { render, screen } from '@testing-library/react-native';

import { WeeklyBars } from './weekly-bars';

const weeks = Array.from({ length: 12 }, (_, i) => i * 1800);

// PLAYER-06: drawn before it was laid out (0 wide, less the card's inset), the chart was
// an <svg width="-42">.
describe('WeeklyBars', () => {
  it('draws nothing at no width, keeping its height', async () => {
    for (const width of [0, -42]) {
      await render(<WeeklyBars weeks={weeks} width={width} />);
      expect(screen.queryByLabelText(/^Hours listened per week/)).toBeNull();
      expect(screen.queryByTestId('bars-pointer')).toBeNull();
      const box = screen.toJSON() as unknown as { props: { style: { height: number } } };
      expect(box.props.style).toEqual({ height: 170 });
    }
  });

  it('draws the chart once it has a width', async () => {
    await render(<WeeklyBars weeks={weeks} width={300} />);
    expect(screen.getByLabelText(/^Hours listened per week/)).toBeTruthy();
    expect(screen.getByTestId('bars-pointer')).toBeTruthy();
  });
});
