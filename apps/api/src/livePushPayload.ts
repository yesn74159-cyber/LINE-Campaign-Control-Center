import type { DeliveryMode } from './types.js';
import { assertFlexJson } from './validation.js';

export interface LivePushBodyInput {
  lineUserId: unknown;
  flexMessage: unknown;
}

export type LivePushBody = {
  to: string;
  messages: Array<Record<string, unknown>>;
};

/**
 * Creates a single-recipient LINE Messaging API push body.
 *
 * This is intentionally NOT wired to LiveLineMessagingAdapter yet.
 * An authenticated caller must first enforce OA/provider identity,
 * consent and opt-out, campaign approval, quota, kill switches, frozen
 * revision, per-recipient idempotency, and the explicit LIVE release gate.
 * No network operations occur in this module.
 */
export function buildLivePushBody(input: LivePushBodyInput): LivePushBody {
  const userId = input.lineUserId;
  if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/i.test(userId)) {
    throw new Error('recipient must be an OA-scoped LINE userId obtained from a verified event');
  }

  const flex = assertFlexJson(input.flexMessage);
  const altText = flex.altText;
  if (typeof altText !== 'string' || altText.trim().length === 0) {
    throw new Error('Flex message altText must not be empty');
  }

  // Clone to avoid mutation of an approved revision after snapshotting.
  return { to: userId, messages: [structuredClone(flex)] };
}

/**
 * Used by a future live scheduler to forbid accidental dry-run/live
 * crossovers, rather than using a default mode.
 */
export function assertExplicitLiveDelivery(mode: DeliveryMode, approvedLiveGate: boolean): void {
  if (mode !== 'LIVE' || approvedLiveGate !== true) {
    throw new Error('Live LINE delivery requires explicit LIVE mode and release authorization');
  }
}
