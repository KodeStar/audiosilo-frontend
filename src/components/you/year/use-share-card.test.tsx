import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus, type View } from 'react-native';

const mockCapture = jest.fn();
const mockDeliver = jest.fn();
jest.mock('./share-card', () => ({
  captureCard: (...a: unknown[]) => mockCapture(...a),
  deliverCard: (...a: unknown[]) => mockDeliver(...a),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import { useShareCard } from './use-share-card';
/* eslint-enable import/first */

const opts = { fileName: 'audiosilo-2026-01-hours.png', title: 'My 2026 in listening' };
const card = { current: {} as View };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockCapture.mockResolvedValue('file:///card.png');
  mockDeliver.mockResolvedValue('shared');
});
afterEach(() => jest.restoreAllMocks());

describe('useShareCard', () => {
  it('captures the card and hands it to the share sheet, busy meanwhile', async () => {
    let finish: (v: string) => void = () => {};
    mockDeliver.mockReturnValue(new Promise((r) => (finish = r)));
    const { result } = await renderHook(() => useShareCard());
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.share(card, opts);
    });
    expect(result.current.busy).toBe(true);
    expect(mockDeliver).toHaveBeenCalledWith('file:///card.png', opts);
    await act(async () => {
      finish('shared');
      await done;
    });
    expect(result.current.busy).toBe(false);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('stays busy (the story held) until the app is back from the app shared to', async () => {
    // Android's share sheet answers once a target is picked, while Files is still open
    // over the app: the story kept advancing behind it.
    const app = AppState as { currentState: AppStateStatus };
    const was = app.currentState;
    app.currentState = 'background';
    const listeners: ((s: AppStateStatus) => void)[] = [];
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
      listeners.push(fn as (s: AppStateStatus) => void);
      return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    const { result } = await renderHook(() => useShareCard());
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = result.current.share(card, opts);
    });
    expect(mockDeliver).toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    // Still away: a second change to background keeps it held.
    await act(async () => listeners.forEach((l) => l('background')));
    expect(result.current.busy).toBe(true);
    // A second press meanwhile does nothing.
    await act(async () => result.current.share(card, opts));
    expect(mockCapture).toHaveBeenCalledTimes(1);
    app.currentState = 'active';
    await act(async () => {
      listeners.forEach((l) => l('active'));
      await done;
    });
    expect(result.current.busy).toBe(false);
    expect(remove).toHaveBeenCalled();
    app.currentState = was;
  });

  it('tries the capture once more with plain covers, never the share sheet twice', async () => {
    mockCapture.mockRejectedValueOnce(new Error('hardware bitmap'));
    const { result } = await renderHook(() => useShareCard());
    await act(async () => result.current.share(card, opts));
    expect(mockCapture).toHaveBeenCalledTimes(2);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(result.current.coversOff).toBe(false);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('says it could not make the image when both captures fail', async () => {
    mockCapture.mockRejectedValue(new Error('no'));
    const { result } = await renderHook(() => useShareCard());
    await act(async () => result.current.share(card, opts));
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't make the image" }),
    );
  });

  it('does not retry a share sheet that failed', async () => {
    mockDeliver.mockRejectedValue(new Error('sheet'));
    const { result } = await renderHook(() => useShareCard());
    await act(async () => result.current.share(card, opts));
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't make the image" }),
    );
  });

  it('says where a download went', async () => {
    mockDeliver.mockResolvedValue('downloaded');
    const { result } = await renderHook(() => useShareCard());
    await act(async () => result.current.share(card, opts));
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Image saved',
      description: 'audiosilo-2026-01-hours.png is in your downloads.',
    });
  });

  it('runs one share at a time', async () => {
    mockDeliver.mockReturnValue(new Promise(() => {}));
    const { result } = await renderHook(() => useShareCard());
    await act(async () => {
      void result.current.share(card, opts);
      void result.current.share(card, opts);
    });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
