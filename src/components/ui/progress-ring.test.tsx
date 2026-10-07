import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ProgressRing } from './progress-ring';

/** The two half-arc windows' turns, right then left (degrees). */
function turns(): string[] {
  const json = JSON.stringify(screen.toJSON());
  return [...json.matchAll(/"rotate":"(-?\d+(?:\.\d+)?)deg"/g)].map((m) => m[1]);
}

describe('ProgressRing', () => {
  it.each([
    [1, ['0', '180']],
    [0.75, ['0', '90']],
    [0.25, ['-90', '0']],
    [-1, ['-180', '0']],
  ])('turns its halves away as the fraction falls (transform only): %s', async (f, want) => {
    await render(<ProgressRing fraction={f} size={42} stroke={4} color="#000" />);
    expect(turns()).toEqual(want);
  });

  it('centres its content and hides itself from screen readers', async () => {
    await render(
      <ProgressRing fraction={0.5} size={42} stroke={4} color="#000">
        <Text>7</Text>
      </ProgressRing>,
    );
    expect(screen.getByText('7', { includeHiddenElements: true })).toBeTruthy();
    const root = screen.toJSON() as { props: Record<string, unknown> };
    expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(root.props.accessibilityElementsHidden).toBe(true);
  });
});
