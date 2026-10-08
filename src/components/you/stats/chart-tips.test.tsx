import { fireEvent, render, screen } from '@testing-library/react-native';

import type { ListeningDay } from '@/api/types';
import { addDays } from '@/components/home/listening';

import { ListeningCalendar } from './listening-calendar';
import { ListeningClock } from './listening-clock';
import { clockSummary } from './stats-model';
import { WeeklyBars } from './weekly-bars';

/**
 * A chart's tooltip outliving the data it was picked on: the stats reload when the app
 * comes back (and a day rolls over), and a tip kept from before must never index the new
 * data where it means something else, or nothing (the device crash: "Cannot read property
 * 'indexOf' of undefined" in ListeningCalendar after a foreground reload).
 */

/** `n` days ending `today`, every one with an hour. */
function daysTo(today: string, n: number): ListeningDay[] {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(today, i - n + 1), listened: 3600 }));
}

const tap = (testID: string, x: number, y: number) =>
  fireEvent.press(screen.getByTestId(testID), { nativeEvent: { locationX: x, locationY: y } });

describe('ListeningCalendar tooltip across reloads', () => {
  // 750 wide: 11 pt cells (the minimum) with a 3 gap.
  const pitch = 11 + 3;
  const SUNDAY = '2026-10-11';

  it('closes the tip when the reloaded grid moves its day (a week rolling over)', async () => {
    const before = daysTo(SUNDAY, 400);
    const view = await render(<ListeningCalendar days={before} today={SUNDAY} width={750} />);
    // Column 51, row 3: Thursday 1 October.
    await tap('calendar-pointer', 51 * pitch + 2, 3 * pitch + 2);
    expect(screen.getByTestId('calendar-tip')).toBeTruthy();
    expect(screen.getByText(/Thu 1 Oct|Oct 1/)).toBeTruthy();

    // Monday: every column moved one week left, so that slot is now Thursday 8 October.
    const monday = addDays(SUNDAY, 1);
    await view.rerender(<ListeningCalendar days={daysTo(monday, 30)} today={monday} width={750} />);
    expect(screen.queryByTestId('calendar-tip')).toBeNull();
  });

  it('closes the tip when the reload has fewer days, without throwing', async () => {
    const view = await render(
      <ListeningCalendar days={daysTo(SUNDAY, 400)} today={SUNDAY} width={750} />,
    );
    await tap('calendar-pointer', 2, 2);
    expect(screen.getByTestId('calendar-tip')).toBeTruthy();
    await view.rerender(<ListeningCalendar days={daysTo(SUNDAY, 3)} today={SUNDAY} width={750} />);
    expect(screen.queryByTestId('calendar-tip')).toBeNull();
  });

  it('keeps the tip while the data is the same', async () => {
    const days = daysTo(SUNDAY, 400);
    const view = await render(<ListeningCalendar days={days} today={SUNDAY} width={750} />);
    await tap('calendar-pointer', 51 * pitch + 2, 3 * pitch + 2);
    await view.rerender(<ListeningCalendar days={days} today={SUNDAY} width={760} />);
    expect(screen.getByTestId('calendar-tip')).toBeTruthy();
  });
});

describe('WeeklyBars tooltip across reloads', () => {
  it('closes the tip when its bar is gone', async () => {
    const weeks = Array.from({ length: 12 }, (_, i) => (i + 1) * 3600);
    const view = await render(<WeeklyBars weeks={weeks} width={676} />);
    // The last bar: this week.
    await tap('bars-pointer', 670, 50);
    expect(screen.getByTestId('bars-tip')).toBeTruthy();
    await view.rerender(<WeeklyBars weeks={weeks.slice(0, 6)} width={676} />);
    expect(screen.queryByTestId('bars-tip')).toBeNull();
  });
});

describe('ListeningClock picked hour across reloads', () => {
  const size = 280;
  const at = (hour: number) => {
    const a = (((hour + 0.5) / 24) * 360 - 90) * (Math.PI / 180);
    return [size / 2 + Math.cos(a) * size * 0.35, size / 2 + Math.sin(a) * size * 0.35] as const;
  };
  const rows = (seconds: number) => [Array.from({ length: 24 }, (_, h) => (h === 7 ? seconds : 0))];

  it('reads the picked hour from the reloaded data', async () => {
    const view = await render(<ListeningClock summary={clockSummary(rows(3600))} size={size} />);
    await tap('clock-pointer', ...at(7));
    expect(screen.getByText('1h this year')).toBeTruthy();
    await view.rerender(<ListeningClock summary={clockSummary(rows(7200))} size={size} />);
    expect(screen.getByText('2h this year')).toBeTruthy();
  });

  it('drops a picked hour the summary does not have', async () => {
    const view = await render(<ListeningClock summary={clockSummary(rows(3600))} size={size} />);
    await tap('clock-pointer', ...at(20));
    expect(screen.getByText('0m this year')).toBeTruthy();
    const short = { ...clockSummary(rows(3600)), hours: Array.from({ length: 12 }, () => 0) };
    await view.rerender(<ListeningClock summary={short} size={size} />);
    expect(screen.queryByText(/this year/)).toBeNull();
    expect(screen.getByText('your busiest hour')).toBeTruthy();
  });
});
