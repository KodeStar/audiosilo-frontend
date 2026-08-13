import { fireEvent, render, screen } from '@testing-library/react-native';

import { TimeStepper } from './time-stepper';

// `render` and `fireEvent` are async in @testing-library/react-native 14 - await
// both, or a later case in this file renders into a detached tree.

// The a11y labels come from the real English catalog (jest.setup initialises i18next).
const EARLIER = 'From, 30 minutes earlier';
const LATER = 'From, 30 minutes later';

describe('TimeStepper', () => {
  it('steps by half an hour in each direction', async () => {
    const onChange = jest.fn();
    await render(<TimeStepper value="22:00" onChange={onChange} label="From" />);

    await fireEvent.press(screen.getByLabelText(LATER));
    expect(onChange).toHaveBeenCalledWith('22:30');

    await fireEvent.press(screen.getByLabelText(EARLIER));
    expect(onChange).toHaveBeenCalledWith('21:30');
  });

  it('wraps forward past the end of the day instead of clamping', async () => {
    const onChange = jest.fn();
    await render(<TimeStepper value="23:30" onChange={onChange} label="From" />);

    await fireEvent.press(screen.getByLabelText(LATER));
    expect(onChange).toHaveBeenCalledWith('00:00');
  });

  it('wraps backward past midnight instead of clamping', async () => {
    const onChange = jest.fn();
    await render(<TimeStepper value="00:00" onChange={onChange} label="From" />);

    await fireEvent.press(screen.getByLabelText(EARLIER));
    expect(onChange).toHaveBeenCalledWith('23:30');
  });

  it('treats a malformed stored value as midnight rather than crashing', async () => {
    const onChange = jest.fn();
    await render(<TimeStepper value="oops" onChange={onChange} label="From" />);

    await fireEvent.press(screen.getByLabelText(LATER));
    expect(onChange).toHaveBeenCalledWith('00:30');
  });

  it('labels each button with the row it belongs to', async () => {
    await render(<TimeStepper value="06:00" onChange={jest.fn()} label="Until" />);

    expect(screen.getByLabelText('Until, 30 minutes earlier')).toBeTruthy();
    expect(screen.getByLabelText('Until, 30 minutes later')).toBeTruthy();
  });

  it('shows the value in the reader own clock convention', async () => {
    await render(<TimeStepper value="22:00" onChange={jest.fn()} label="From" />);

    // ICU has varied the space before AM/PM between versions, so normalise it.
    const readout = screen.getByText(/10:00/).props.children as string;
    expect(readout.replace(/\s/g, ' ')).toBe('10:00 PM');
  });
});
