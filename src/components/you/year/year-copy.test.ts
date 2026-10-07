import i18n from '@/i18n';

import { cardCopy, cardSpeech, listenTime } from './year-copy';
import { yearStats } from './year-fixture';
import { buildYearCards, type YearCard } from './year-model';

const t = i18n.t;
const ctx = { year: '2026', userName: 'alex', serverName: 'Hearthside' };
const cards = buildYearCards({ stats: yearStats(), current: true, currentStreak: 3, goal: 50 });
const copyOf = (kind: YearCard['kind'], c: YearCard[] = cards) =>
  cardCopy(
    c.find((x) => x.kind === kind)!,
    ctx,
    t,
  );

describe('cardCopy', () => {
  it('opens on the hours, named, with the whole days and the sessions', () => {
    const copy = copyOf('hours');
    expect(copy.kicker).toBe('AudioSilo · Hearthside');
    expect(copy.title).toBe("alex, here's your 2026 in listening.");
    expect(copy.big).toBe('412');
    expect(copy.unit).toBe('hours');
    expect(copy.body).toEqual([
      "That's 17 whole days with a book in your ears.",
      'Across 380 sessions and 52 books.',
    ]);
    expect(copy.thumb).toBe('412 hours');
  });

  it('says how much of the hours is estimated', () => {
    const c = buildYearCards({
      stats: yearStats({ estimated: 3 * 3600 }),
      current: false,
      currentStreak: null,
      goal: null,
    });
    expect(copyOf('hours', c).body.at(-1)).toBe(
      'About 3 hours of it is estimated, from before Hearthside kept sessions.',
    );
  });

  it('counts the books against the goal', () => {
    expect(copyOf('books').body[0]).toBe('9 more to reach your goal of 50.');
    const reached = buildYearCards({
      stats: yearStats(),
      current: true,
      currentStreak: 0,
      goal: 40,
    });
    expect(copyOf('books', reached).body[0]).toBe('Your goal was 40. Done.');
  });

  it('names the book and the voice of the year with their time', () => {
    expect(copyOf('book')).toMatchObject({
      title: 'The Way of Kings',
      body: ['By Brandon Sanderson.', '36 hours of listening, more than any other book.'],
    });
    expect(copyOf('voice')).toMatchObject({
      title: '61 hours with Michael Kramer',
      body: ['Then Jeff Hays (45 hours) and Ray Porter (28 hours).'],
    });
  });

  it('reads the busiest hour as a time of day', () => {
    const copy = copyOf('clock');
    expect(copy.title).toBe('A night owl.');
    expect(copy.clock?.caption).toBe('your busiest hour');
    expect(copy.body[0]).toMatch(/^You listened most around (22:00|10:00\sPM)\.$/);
  });

  it('says whether the longest streak is the one still running', () => {
    expect(copyOf('streak').body).toEqual(["You're on day 3 of a new one right now."]);
    const going = buildYearCards({
      stats: yearStats(),
      current: true,
      currentStreak: 38,
      goal: null,
    });
    expect(copyOf('streak', going).body).toEqual(["And it's still going."]);
    expect(copyOf('streak', going).thumb).toBe('38-day streak');
  });

  it('sums the year up with figures', () => {
    const copy = copyOf('summary');
    expect(copy.kicker).toBe('2026 · alex');
    expect(copy.figures).toEqual([
      { value: '412', label: 'hours listened' },
      { value: '41', label: 'books finished' },
      { value: '38', label: 'day streak' },
      { value: '52', label: 'books listened to' },
    ]);
  });

  it('keeps time short under two hours', () => {
    expect(listenTime(80 * 60, t)).toBe('1h 20m');
    expect(listenTime(7200, t)).toBe('2 hours');
    expect(listenTime(10, t)).toBe('10s');
  });
});

describe('cardSpeech', () => {
  it('reads everything a card says, as sentences', () => {
    expect(cardSpeech(copyOf('people'))).toBe(
      'Who you kept coming back to. Author of the year: Brandon Sanderson, 90 hours across 5 books. Series of the year: The Stormlight Archive, 70 hours across 3 books.',
    );
    expect(cardSpeech(copyOf('hours'))).toContain('412 hours.');
  });
});
