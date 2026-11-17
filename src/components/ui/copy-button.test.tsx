import { fireEvent, render, screen } from '@testing-library/react-native';

const mockCopy = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/lib/clipboard', () => ({ copyText: (s: string) => mockCopy(s) }));

/* eslint-disable import/first */
import { CodeBox, CopyButton } from './copy-button';
/* eslint-enable import/first */

beforeEach(() => mockCopy.mockReset());

describe('CopyButton', () => {
  it('says Copied once the text reached the clipboard, and Copy again for a new text', async () => {
    mockCopy.mockResolvedValue(true);
    const view = await render(<CopyButton text="https://a/1" title="Copy link" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    expect(mockCopy).toHaveBeenCalledWith('https://a/1');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    // A renewed link has not been copied.
    await view.rerender(<CopyButton text="https://a/2" title="Copy link" />);
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('confirms nothing when the text went to a share sheet instead', async () => {
    mockCopy.mockResolvedValue(false);
    await render(<CopyButton text="secret" title="Copy key" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Copy key' }));
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeTruthy();
  });
});

it('shows a code as selectable text', async () => {
  await render(<CodeBox testID="code">abc-123</CodeBox>);
  expect(screen.getByTestId('code')).toHaveTextContent('abc-123');
  expect(screen.getByTestId('code').props.selectable).toBe(true);
});
