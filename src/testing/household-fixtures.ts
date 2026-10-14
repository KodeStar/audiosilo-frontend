import type { HouseholdMember } from '@/api/types';

/** A household member (Phase 8b-1) as the server answers one: Evie, a kid on "Only
 * collections I share" with none shared yet, signed in nowhere. */
export function householdMember(over: Partial<HouseholdMember> = {}): HouseholdMember {
  return {
    id: 12,
    name: 'Evie',
    username: 'evie',
    kind: 'kid',
    access: 'collections',
    created_at: '2026-10-13T10:00:00.000Z',
    collections: [],
    devices: 0,
    last_listened_at: null,
    ...over,
  };
}

/**
 * `@/components/connect/add-member-here` for a screen's suite (its own suite tests it):
 * `jest.mock('@/components/connect/add-member-here', () =>
 *   require('@/testing/household-fixtures').addMemberHereMock({ addMemberHere: ..., memberSignedInHere: ... }))`,
 * each a wrapper that reads the suite's own `mock...` function when called. The error keeps
 * the real one's `code`.
 */
export function addMemberHereMock(fns: {
  addMemberHere: (...a: unknown[]) => unknown;
  memberSignedInHere: (...a: unknown[]) => unknown;
}) {
  class AddMemberHereError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'AddMemberHereError';
    }
  }
  return { AddMemberHereError, ...fns };
}
