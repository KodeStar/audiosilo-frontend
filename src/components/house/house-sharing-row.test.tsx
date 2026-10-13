import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { HouseholdSettings } from '@/api/types';

let mockSettings: {
  data?: HouseholdSettings;
  isError: boolean;
  refetch: jest.Mock;
};
const mockMutate = jest.fn();
jest.mock('@/api/hooks', () => {
  class CapabilityError extends Error {}
  return {
    CapabilityError,
    useHousehold: () => mockSettings,
    useSetHousehold: () => ({ mutateAsync: (share: boolean) => mockMutate(share) }),
  };
});
/** The stored user's `member_kind` on c1 (a test's own). */
let mockKind: 'kid' | 'grownup' | undefined;
jest.mock('@/stores/session', () => ({
  useConnectionName: (id: string) => (id === 'c1' ? 'Hearthside' : ''),
  useSession: (selector: (s: unknown) => unknown) =>
    selector({ connections: [{ id: 'c1', user: { id: 1, member_kind: mockKind } }] }),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import { CapabilityError } from '@/api/hooks';

import { HouseSharingRow } from './house-sharing-row';
/* eslint-enable import/first */

const SWITCH = "Share what I'm listening to with the house on Hearthside";

/** A promise the test settles by hand, to look at the row while a change is in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockKind = undefined;
  mockSettings = { data: { share_listening: false }, isError: false, refetch: jest.fn() };
  mockMutate.mockReset();
  mockToast.mockReset();
});

describe('HouseSharingRow', () => {
  it('says what sharing shows and to whom, off by default', async () => {
    await render(<HouseSharingRow connectionId="c1" />);
    expect(screen.getByText("Share what I'm listening to with the house")).toBeTruthy();
    expect(
      screen.getByText(
        'Your current book shows on the Home page of other people on Hearthside who share theirs too. Off by default.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('switch', { name: SWITCH })).not.toBeChecked();
  });

  it('is hidden for a connection that is gone', async () => {
    await render(<HouseSharingRow connectionId="other" />);
    expect(screen.toJSON()).toBeNull();
  });

  it('turns on at once, waits while saving, then settles on the answer', async () => {
    const save = deferred<HouseholdSettings>();
    mockMutate.mockReturnValue(save.promise);
    await render(<HouseSharingRow connectionId="c1" />);

    await fireEvent.press(screen.getByRole('switch', { name: SWITCH }));
    expect(mockMutate).toHaveBeenCalledWith(true);
    const sw = screen.getByRole('switch', { name: SWITCH });
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
    expect(screen.getByText('Saving')).toBeTruthy();

    // The hook stores the answer before it resolves.
    mockSettings = { ...mockSettings, data: { share_listening: true } };
    await act(async () => save.resolve({ share_listening: true }));
    expect(screen.getByRole('switch', { name: SWITCH })).toBeChecked();
    expect(screen.getByRole('switch', { name: SWITCH })).toBeEnabled();
    expect(screen.queryByText('Saving')).toBeNull();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('puts the switch back and says so when the change fails', async () => {
    mockMutate.mockRejectedValue(new Error('network'));
    await render(<HouseSharingRow connectionId="c1" />);
    await fireEvent.press(screen.getByRole('switch', { name: SWITCH }));
    expect(screen.getByRole('switch', { name: SWITCH })).not.toBeChecked();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Couldn't change sharing on Hearthside",
      description: 'Nothing changed. Check the connection and try again.',
    });
  });

  it('tells a demo account it cannot share', async () => {
    mockMutate.mockRejectedValue(new ApiError(403, 'demo'));
    await render(<HouseSharingRow connectionId="c1" />);
    await fireEvent.press(screen.getByRole('switch', { name: SWITCH }));
    expect(mockToast).toHaveBeenCalledWith({
      title: "Demo accounts can't share what they listen to.",
    });
  });

  it("tells a kid's account it cannot share in its own words (a coded 403)", async () => {
    mockMutate.mockRejectedValue(new ApiError(403, 'kid accounts cannot', 'kid_account'));
    await render(<HouseSharingRow connectionId="c1" />);
    await fireEvent.press(screen.getByRole('switch', { name: SWITCH }));
    expect(mockToast).toHaveBeenCalledWith({
      title: "A kid's account can't share what it listens to.",
    });
  });

  it("says a kid's account can't share, switched off, never offering the switch", async () => {
    mockKind = 'kid';
    await render(<HouseSharingRow connectionId="c1" />);
    expect(screen.getByText("A kid's account can't share what it listens to.")).toBeTruthy();
    expect(screen.queryByText(/Demo accounts/)).toBeNull();
    const sw = screen.getByRole('switch', { name: SWITCH });
    expect(sw).not.toBeChecked();
    expect(sw).toBeDisabled();
  });

  it('says nothing when the request was never sent (the flag went away)', async () => {
    mockMutate.mockRejectedValue(new CapabilityError('household'));
    await render(<HouseSharingRow connectionId="c1" />);
    await fireEvent.press(screen.getByRole('switch', { name: SWITCH }));
    expect(mockToast).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: SWITCH })).not.toBeChecked();
  });

  it('waits disabled while loading, and offers Retry when the load failed', async () => {
    mockSettings = { data: undefined, isError: false, refetch: jest.fn() };
    await render(<HouseSharingRow connectionId="c1" />);
    expect(screen.getByRole('switch', { name: SWITCH })).toBeDisabled();
    expect(screen.queryByText("Couldn't load this setting.")).toBeNull();

    mockSettings = { data: undefined, isError: true, refetch: jest.fn() };
    await render(<HouseSharingRow connectionId="c1" />);
    expect(screen.getByText("Couldn't load this setting.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(mockSettings.refetch).toHaveBeenCalled();
  });
});
