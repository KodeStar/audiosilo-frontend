import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DRIFT_STORAGE_KEY,
  DRIFT_TTL_MS,
  driftOffer,
  pruneDrifts,
  saveDrift,
  takeDrift,
  type DriftRecord,
} from './drift';

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

/** Fell asleep 4 minutes after the last touch, recorded at NOW. */
const record = (over: Partial<DriftRecord> = {}): DriftRecord => ({
  touchAt: NOW - 10 * 60_000,
  touchPosition: 1000,
  stoppedAt: 1240,
  recordedAt: NOW,
  ...over,
});

describe('driftOffer', () => {
  it('offers the jump back to the last touch, in rounded content minutes', () => {
    expect(driftOffer(record(), NOW + HOUR, 1240)).toEqual({
      jumpTo: 1000,
      minutes: 4,
      touchAt: NOW - 10 * 60_000,
    });
    expect(driftOffer(record({ stoppedAt: 1000 + 150 }), NOW, 1150)?.minutes).toBe(3);
  });

  it('offers nothing for a gap under a minute or over an hour', () => {
    expect(driftOffer(record({ stoppedAt: 1059 }), NOW, 1059)).toBeNull();
    expect(driftOffer(record({ stoppedAt: 1060 }), NOW, 1060)?.minutes).toBe(1);
    expect(driftOffer(record({ stoppedAt: 1000 + 3600 }), NOW, 4600)?.minutes).toBe(60);
    expect(driftOffer(record({ stoppedAt: 1000 + 3601 }), NOW, 4601)).toBeNull();
  });

  it('offers nothing once the record is older than 36 hours', () => {
    expect(driftOffer(record(), NOW + DRIFT_TTL_MS, 1240)).not.toBeNull();
    expect(driftOffer(record(), NOW + DRIFT_TTL_MS + 1, 1240)).toBeNull();
  });

  it('offers nothing when the book starts somewhere else', () => {
    expect(driftOffer(record(), NOW, 1235)).not.toBeNull(); // auto-rewind
    expect(driftOffer(record(), NOW, 1240 + 600)).toBeNull(); // listened on elsewhere
    expect(driftOffer(record(), NOW, 200)).toBeNull(); // moved back already
  });
});

describe('pruneDrifts', () => {
  it('drops malformed and stale records', () => {
    const raw = {
      fresh: record(),
      stale: record({ recordedAt: NOW - DRIFT_TTL_MS - 1 }),
      future: record({ recordedAt: NOW + HOUR }),
      broken: { touchAt: 'x' },
    };
    expect(Object.keys(pruneDrifts(raw, NOW))).toEqual(['fresh']);
  });

  it('reads anything that is not a document as empty', () => {
    expect(pruneDrifts(null, NOW)).toEqual({});
    expect(pruneDrifts([record()], NOW)).toEqual({});
    expect(pruneDrifts('x', NOW)).toEqual({});
  });

  it('keeps only the newest twenty', () => {
    const raw = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`b${i}`, record({ recordedAt: NOW - i * 1000 })]),
    );
    const kept = pruneDrifts(raw, NOW);
    expect(Object.keys(kept)).toHaveLength(20);
    expect(kept.b0).toBeDefined();
    expect(kept.b24).toBeUndefined();
  });
});

describe('saveDrift / takeDrift', () => {
  beforeEach(() => AsyncStorage.clear());

  it('offers a saved record once', async () => {
    await saveDrift('srv-1:1:a', record());
    expect(await takeDrift('srv-1:1:a', NOW)).toEqual(record());
    expect(await takeDrift('srv-1:1:a', NOW)).toBeNull();
  });

  it('keeps books (and servers) apart', async () => {
    await saveDrift('srv-1:1:a', record());
    await saveDrift('srv-2:1:a', record({ stoppedAt: 2000 }));
    expect((await takeDrift('srv-2:1:a', NOW))?.stoppedAt).toBe(2000);
    expect((await takeDrift('srv-1:1:a', NOW))?.stoppedAt).toBe(1240);
  });

  it('never loses one of two writes started together', async () => {
    await Promise.all([saveDrift('a', record()), saveDrift('b', record())]);
    const stored = JSON.parse((await AsyncStorage.getItem(DRIFT_STORAGE_KEY))!);
    expect(Object.keys(stored).sort()).toEqual(['a', 'b']);
  });

  it('does not offer a record that went stale in storage', async () => {
    await saveDrift('a', record());
    expect(await takeDrift('a', NOW + DRIFT_TTL_MS + 1)).toBeNull();
  });
});
