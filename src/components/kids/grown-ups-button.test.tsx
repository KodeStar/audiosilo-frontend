import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { GrownUpsButton, HOLD_MS } from './grown-ups-button';

const button = () => screen.getByTestId('kids-grown-ups');
const hold = () => fireEvent(button(), 'pressIn');
const release = () => fireEvent(button(), 'pressOut');
const wait = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  (useReducedMotion as jest.Mock).mockReturnValue(false);
});

it('leaves kids mode after a 2 second hold, with a fill and "Keep holding"', async () => {
  const onExit = jest.fn();
  await render(<GrownUpsButton onExit={onExit} />);
  expect(screen.getByText('Grown-ups: hold')).toBeTruthy();
  expect(screen.getByTestId('kids-grown-ups-fill')).toBeTruthy();
  await hold();
  expect(screen.getByText('Keep holding')).toBeTruthy();
  await wait(HOLD_MS - 1);
  expect(onExit).not.toHaveBeenCalled();
  await wait(1);
  expect(onExit).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Grown-ups: hold')).toBeTruthy();
  // Letting go after it fired does nothing more.
  await release();
  await wait(HOLD_MS);
  expect(onExit).toHaveBeenCalledTimes(1);
});

it('does nothing when let go early, and a new hold starts over', async () => {
  const onExit = jest.fn();
  await render(<GrownUpsButton onExit={onExit} />);
  await hold();
  await wait(1500);
  await release();
  expect(screen.getByText('Grown-ups: hold')).toBeTruthy();
  await wait(HOLD_MS);
  expect(onExit).not.toHaveBeenCalled();

  await hold();
  await wait(1500); // not 2 s since this hold began
  expect(onExit).not.toHaveBeenCalled();
  await wait(500);
  expect(onExit).toHaveBeenCalledTimes(1);
});

it('never exits on a tap (a child tapping it is the case it exists for)', async () => {
  const onExit = jest.fn();
  await render(<GrownUpsButton onExit={onExit} />);
  for (let i = 0; i < 5; i++) {
    await hold();
    await wait(120);
    await release();
    await fireEvent.press(button());
  }
  await wait(HOLD_MS * 2);
  expect(onExit).not.toHaveBeenCalled();
});

it('with reduced motion: no fill animation, still a full 2 seconds', async () => {
  (useReducedMotion as jest.Mock).mockReturnValue(true);
  const onExit = jest.fn();
  await render(<GrownUpsButton onExit={onExit} />);
  expect(screen.queryByTestId('kids-grown-ups-fill')).toBeNull();
  await hold();
  expect(screen.getByText('Keep holding')).toBeTruthy();
  await wait(HOLD_MS - 1);
  expect(onExit).not.toHaveBeenCalled();
  await wait(1);
  expect(onExit).toHaveBeenCalledTimes(1);
});

it('tells a screen reader to hold, and leaves on the long-press action', async () => {
  const onExit = jest.fn();
  await render(<GrownUpsButton onExit={onExit} />);
  const b = screen.getByRole('button', { name: 'Grown-ups' });
  expect(b.props.accessibilityHint).toBe('Hold to leave kids mode');
  expect(b.props.accessibilityActions).toEqual([{ name: 'longpress', label: 'Leave kids mode' }]);
  await fireEvent(b, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(onExit).not.toHaveBeenCalled();
  await fireEvent(b, 'accessibilityAction', { nativeEvent: { actionName: 'longpress' } });
  expect(onExit).toHaveBeenCalledTimes(1);
});

it('never fires after it has gone away mid-hold', async () => {
  const onExit = jest.fn();
  const view = await render(<GrownUpsButton onExit={onExit} />);
  await hold();
  await view.unmount();
  await wait(HOLD_MS);
  expect(onExit).not.toHaveBeenCalled();
});
