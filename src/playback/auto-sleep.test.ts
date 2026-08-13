import {
  canAutoSleepArm,
  decideAutoSleep,
  EMPTY_AUTO_SLEEP_MEMORY,
  MAX_REMEMBERED_BOOKS,
  recordAutoSleepOutcome,
  type AutoSleepInput,
  type AutoSleepMemory,
} from '@/playback/auto-sleep';

/** 23:30 local - inside the default 22:00 -> 06:00 window. */
const NIGHT = new Date(2026, 0, 15, 23, 30);
/** 14:00 local - outside it. */
const DAY = new Date(2026, 0, 15, 14, 0);

const BOOK = 'cid:1:some/book.m4b';

function input(overrides: Partial<AutoSleepInput> = {}): AutoSleepInput {
  return {
    enabled: true,
    from: '22:00',
    until: '06:00',
    type: 'chapter',
    now: NIGHT,
    bookKey: BOOK,
    memory: EMPTY_AUTO_SLEEP_MEMORY,
    ...overrides,
  };
}

describe('decideAutoSleep', () => {
  it('arms an end-of-chapter timer inside the window', () => {
    expect(decideAutoSleep(input())).toEqual({ arm: 'chapter' });
  });

  it('arms a duration timer for a minutes type', () => {
    expect(decideAutoSleep(input({ type: '45' }))).toEqual({ arm: 'duration', minutes: 45 });
  });

  it('does nothing when the feature is off', () => {
    expect(decideAutoSleep(input({ enabled: false }))).toEqual({ arm: 'none' });
  });

  it('does nothing outside the nightly window', () => {
    expect(decideAutoSleep(input({ now: DAY }))).toEqual({ arm: 'none' });
  });

  it('does nothing with no book loaded', () => {
    expect(decideAutoSleep(input({ bookKey: null }))).toEqual({ arm: 'none' });
  });

  // --- the anti-nag rules --------------------------------------------------
  //
  // "A timer is already standing, whoever armed it" is NOT one of these: it is a live
  // reading of the timer store, enforced by the controller (see its test), not a
  // remembered fact this pure function could be handed.

  it('never arms again for a book the listener cancelled a timer on', () => {
    const memory = recordAutoSleepOutcome(EMPTY_AUTO_SLEEP_MEMORY, BOOK, 'cancelled');
    expect(decideAutoSleep(input({ memory }))).toEqual({ arm: 'none' });
  });

  it('arms again once the previous timer has run its course', () => {
    // The behaviour this whole feature turns on: a timer that fired and finished leaves
    // the book armable, so pressing play again at 3am is protected. The old rule (one
    // timer per book per session) left that listener with nothing for the rest of the
    // night, which is exactly what the feature exists to prevent.
    const memory = recordAutoSleepOutcome(EMPTY_AUTO_SLEEP_MEMORY, BOOK, 'expired');
    expect(decideAutoSleep(input({ memory }))).toEqual({ arm: 'chapter' });
  });

  it('arms nothing for a corrupt persisted type', () => {
    expect(decideAutoSleep(input({ type: 'nonsense' as 'chapter' }))).toEqual({ arm: 'none' });
  });
});

describe('auto sleep memory', () => {
  const OTHER = 'cid:1:other.m4b';

  it('gives a different book a fresh chance', () => {
    const memory = recordAutoSleepOutcome(EMPTY_AUTO_SLEEP_MEMORY, BOOK, 'cancelled');
    expect(canAutoSleepArm(memory, OTHER)).toBe(true);
    expect(decideAutoSleep(input({ bookKey: OTHER, memory }))).toEqual({ arm: 'chapter' });
  });

  it('blocks a cancelled book, idempotently', () => {
    const memory = recordAutoSleepOutcome(EMPTY_AUTO_SLEEP_MEMORY, BOOK, 'cancelled');
    expect([...memory]).toEqual([BOOK]);
    expect(canAutoSleepArm(memory, BOOK)).toBe(false);
    // Already blocked: the same set back, so repeated endings can't churn the ref.
    expect(recordAutoSleepOutcome(memory, BOOK, 'cancelled')).toBe(memory);
    // Nothing loaded is never armable, and never records anything.
    expect(canAutoSleepArm(memory, null)).toBe(false);
    expect(recordAutoSleepOutcome(memory, null, 'cancelled')).toBe(memory);
    expect(recordAutoSleepOutcome(memory, null, 'expired')).toBe(memory);
  });

  it('leaves the memory untouched when a timer merely ran its course', () => {
    expect(recordAutoSleepOutcome(EMPTY_AUTO_SLEEP_MEMORY, BOOK, 'expired')).toBe(
      EMPTY_AUTO_SLEEP_MEMORY,
    );
  });

  it('keeps a cancelled book blocked whatever happens to it later', () => {
    // The strongest rule in the feature: it must not be walked back by a LATER timer
    // (one the listener armed themselves, say) running out on the same book.
    let memory: AutoSleepMemory = recordAutoSleepOutcome(
      EMPTY_AUTO_SLEEP_MEMORY,
      BOOK,
      'cancelled',
    );
    memory = recordAutoSleepOutcome(memory, BOOK, 'expired');
    expect(canAutoSleepArm(memory, BOOK)).toBe(false);
    expect(decideAutoSleep(input({ memory }))).toEqual({ arm: 'none' });
  });

  it('keeps a book blocked after playing something else and coming back', () => {
    // A single slot keyed on one book could not honour "for the rest of its playback
    // session": A -> B -> A wiped A's record and handed the listener a second automatic
    // timer on the very book they had just cancelled one for.
    let memory: AutoSleepMemory = recordAutoSleepOutcome(
      EMPTY_AUTO_SLEEP_MEMORY,
      BOOK,
      'cancelled',
    );
    memory = recordAutoSleepOutcome(memory, OTHER, 'cancelled');
    expect(canAutoSleepArm(memory, BOOK)).toBe(false);
    expect(decideAutoSleep(input({ bookKey: BOOK, memory }))).toEqual({ arm: 'none' });
  });

  it('stays bounded, evicting the oldest book first', () => {
    // It lives for the process lifetime, so it must not grow with every book played.
    let memory = recordAutoSleepOutcome(EMPTY_AUTO_SLEEP_MEMORY, BOOK, 'cancelled');
    for (let i = 0; i < MAX_REMEMBERED_BOOKS; i++) {
      memory = recordAutoSleepOutcome(memory, `cid:1:book-${i}.m4b`, 'cancelled');
    }
    expect(memory.size).toBe(MAX_REMEMBERED_BOOKS);
    expect(canAutoSleepArm(memory, BOOK)).toBe(true); // the oldest, evicted
    expect(canAutoSleepArm(memory, `cid:1:book-${MAX_REMEMBERED_BOOKS - 1}.m4b`)).toBe(false);
  });
});
