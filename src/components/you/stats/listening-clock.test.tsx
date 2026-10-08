import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ListeningClock } from './listening-clock';
import { CLOCK_MIN_SIZE, type ClockSummary, clockCentreWidth, clockGeometry } from './stats-model';

const hours = Array.from({ length: 24 }, (_, i) => (i === 7 ? 3600 : 0));
const summary: ClockSummary = {
  hours,
  max: 3600,
  busiest: 7,
  peak: hours.map((v) => v > 0),
  windows: [{ from: 7, to: 7 }],
};

describe('ListeningClock centre', () => {
  it('lays the caption out in a definite width inside the inner circle, two lines allowed', async () => {
    // Android drew a shrink-wrapped caption wrapped but sized it to one line, clipping
    // "hour" off "your busiest hour".
    await render(<ListeningClock summary={summary} size={CLOCK_MIN_SIZE} />);
    const caption = screen.getByTestId('clock-caption');
    const style = StyleSheet.flatten(caption.props.style);
    expect(style.width).toBe(clockCentreWidth(CLOCK_MIN_SIZE));
    expect(style.textAlign).toBe('center');
    expect(caption.props.numberOfLines).toBe(2);
    expect(screen.getByText('your busiest hour')).toBeTruthy();
  });

  it('keeps the centre width inside the inner circle and roomy at the smallest size', () => {
    for (const size of [CLOCK_MIN_SIZE, 250, 280]) {
      const width = clockCentreWidth(size);
      expect(width).toBeLessThan(clockGeometry(size).r0 * 2);
      // Two caption lines of 12 pt fit in the circle at the smallest clock.
      expect(width).toBeGreaterThanOrEqual(70);
    }
  });
});
