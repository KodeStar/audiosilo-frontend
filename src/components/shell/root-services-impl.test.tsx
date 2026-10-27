// Every service mocked: the test is about starting them all, in order, and stopping all
// but the car (never stopped).
const mockCalls: string[] = [];
const service = (name: string) => () => {
  mockCalls.push(`start ${name}`);
  return () => mockCalls.push(`stop ${name}`);
};
jest.mock('@/playback/auto-sleep-controller', () => ({ startAutoSleep: service('autoSleep') }));
jest.mock('@/playback/drift-controller', () => ({ startDriftWatch: service('drift') }));
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
    const stop = startRootServices();
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
    const view = await render(<RootServices />);
    expect(mockCalls).toContain('start autoSleep');
    expect(mockCalls).toContain('start cast');
    mockCalls.length = 0;
    await view.unmount();
    expect(mockCalls).toContain('stop autoSleep');
    expect(mockCalls).toContain('stop cast');
  });
});
