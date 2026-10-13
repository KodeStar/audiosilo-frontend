import type { TFunction } from 'i18next';

import { ApiError } from '@/api/client';
import type { AuthSession } from '@/api/types';

const mockAddHere = jest.fn();
const mockSignedInHere = jest.fn();
jest.mock('@/components/connect/add-member-here', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/household-fixtures').addMemberHereMock({
    addMemberHere: (...a: unknown[]) => mockAddHere(...a),
    memberSignedInHere: (...a: unknown[]) => mockSignedInHere(...a),
  }),
);

/* eslint-disable import/first */
import { AddMemberHereError } from '@/components/connect/add-member-here';

import { hereFailure, signInMemberHere } from './use-sign-in-here';
/* eslint-enable import/first */

const evie = { id: 12, name: 'Evie' };
const session = { token: 't', server_id: 'srv', user: { id: 12 } } as AuthSession;
const t = ((key: string, o?: { name?: string }) =>
  o?.name ? `${key}:${o.name}` : key) as unknown as TFunction;

beforeEach(() => {
  mockAddHere.mockReset().mockResolvedValue({ connectionId: 'srv.12', profileId: 'p' });
  mockSignedInHere.mockReset().mockReturnValue(false);
});

describe('signInMemberHere', () => {
  it('mints their session and signs them in here, named as their owner named them', async () => {
    const mint = jest.fn(async () => session);
    await expect(signInMemberHere(mint, evie, 'srv')).resolves.toEqual({ status: 'done' });
    expect(mockSignedInHere).toHaveBeenCalledWith('srv', 12);
    expect(mockAddHere).toHaveBeenCalledWith(session, { name: 'Evie' });
  });

  it('never mints a session for a member this device already holds', async () => {
    mockSignedInHere.mockReturnValue(true);
    const mint = jest.fn(async () => session);
    await expect(signInMemberHere(mint, evie, 'srv')).resolves.toEqual({ status: 'already' });
    expect(mint).not.toHaveBeenCalled();
    expect(mockAddHere).not.toHaveBeenCalled();
  });

  it("reads addMemberHere's refusals by their code", async () => {
    const mint = async () => session;
    mockAddHere.mockRejectedValueOnce(new AddMemberHereError('already_here'));
    await expect(signInMemberHere(mint, evie, 'srv')).resolves.toEqual({ status: 'already' });
    mockAddHere.mockRejectedValueOnce(new AddMemberHereError('choose_adult'));
    await expect(signInMemberHere(mint, evie, 'srv')).resolves.toEqual({
      status: 'failed',
      reason: 'choose_adult',
    });
  });

  it("says too many tries when the server's limiter refuses the session, else nothing more", async () => {
    const limited = async () => Promise.reject(new ApiError(429, 'too many attempts'));
    await expect(signInMemberHere(limited, evie, 'srv')).resolves.toEqual({
      status: 'failed',
      reason: 'too_many',
    });
    const down = async () => Promise.reject(new ApiError(500, 'oops'));
    await expect(signInMemberHere(down, evie, 'srv')).resolves.toEqual({ status: 'failed' });
    expect(mockAddHere).not.toHaveBeenCalled();
  });
});

describe('hereFailure', () => {
  it('says each reason in our words, never the server or addMemberHere message', () => {
    expect(hereFailure({ status: 'already' }, 'Evie', t)).toBe('household.here.already:Evie');
    expect(hereFailure({ status: 'failed', reason: 'too_many' }, 'Evie', t)).toBe(
      'common.tooManyTries',
    );
    expect(hereFailure({ status: 'failed', reason: 'not_ready' }, 'Evie', t)).toBe(
      'connect.memberNotReady',
    );
    expect(hereFailure({ status: 'failed', reason: 'choose_adult' }, 'Evie', t)).toBe(
      'profiles.add.chooseAdult',
    );
    expect(hereFailure({ status: 'failed' }, 'Evie', t)).toBe('household.here.failedRetry:Evie');
  });
});
