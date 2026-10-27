// Every service mocked: the test is about starting them all, in order, and stopping all
// but the car (never stopped).
const mockCalls: string[] = [];
const service = (name: string) => () => {
  mockCalls.push(`start ${name}`);
  return () => mockCalls.push(`stop ${name}`);
};
jest.mock('@/playback/auto-sleep-controller', () => ({ startAutoSleep: service('autoSleep') }));
// The options the drift watch was started with (`late` on the web's after-paint start).
const mockDriftOptions: unknown[] = [];
jest.mock('@/playback/drift-controller', () => ({
  startDriftWatch: (o: unknown) => {
    mockDriftOptions.push(o);
    return service('drift')();
  },
}));
jest.mock('@/downloads/keep-ahead-controller', () => ({ startKeepAhead: service('keepAhead') }));
jest.mock('@/downloads/store', () => ({ startChapterRefresh: service('chapters') }));
jest.mock('@/playback/jump-undo', () => ({ startJumpUndo: service('jumpUndo') }));
jest.mock('@/playback/place-reconcile', () => ({ startPlaceReconcile: service('reconcile') }));
jest.mock('@/api/address-runner', () => ({ startAddressRouting: service('addresses') }));
jest.mock('@/widgets/widget-sync', () => ({ startWidgetSync: service('widget') }));
jest.mock('@/car/car-controller', () => ({ startCarSync: () => void mockCalls.push('start car') }));
jest.mock('@/cast/cast-session', () => ({ startCastSync: service('cast') }));
jest.mock('@/components/player/book-ended-listener', () => ({ BookEndedListener: () => null }));
jest.mock('@/components/player/companion/reveal-listener', () => ({
  CompanionRevealListener: () => null,
}));
jest.mock('@/components/player/shake-to-extend-listener', () => ({
  ShakeToExtendListener: () => null,
}));

/* eslint-disable import/first */
import { render } from '@testing-library/react-native';

import { RootServices, startRootServices } from './root-services-impl';
/* eslint-enable import/first */

describe('startRootServices', () => {
  it('starts every service in order and stops all but the car', () => {
    mockDriftOptions.length = 0;
    const stop = startRootServices();
    // Native's start, at the first commit: not a late one.
    expect(mockDriftOptions).toEqual([{ late: false }]);
    expect(mockCalls).toEqual([
      'start autoSleep',
      'start drift',
      'start keepAhead',
      'start chapters',
      'start jumpUndo',
      'start reconcile',
      'start addresses',
      'start widget',
      'start car',
      'start cast',
    ]);
    mockCalls.length = 0;
    stop();
    expect(mockCalls).toEqual([
      'stop autoSleep',
      'stop drift',
      'stop keepAhead',
      'stop chapters',
      'stop jumpUndo',
      'stop reconcile',
      'stop addresses',
      'stop widget',
      'stop cast',
    ]);
  });
});

describe('RootServices (the web mounts it after the first paint)', () => {
  beforeEach(() => {
    mockCalls.length = 0;
  });

  it('starts the services when it mounts and stops them when it goes', async () => {
    mockDriftOptions.length = 0;
    const view = await render(<RootServices />);
    // After the paint: a book already playing is still the drift watch's to offer on.
    expect(mockDriftOptions).toEqual([{ late: true }]);
    expect(mockCalls).toContain('start autoSleep');
    expect(mockCalls).toContain('start cast');
    mockCalls.length = 0;
    await view.unmount();
    expect(mockCalls).toContain('stop autoSleep');
    expect(mockCalls).toContain('stop cast');
  });
});
