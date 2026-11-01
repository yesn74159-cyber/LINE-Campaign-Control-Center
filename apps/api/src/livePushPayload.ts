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

/** Campaign-level preview used when a DRY_RUN job has no consented recipient. */
export const PREVIEW_RECIPIENT = '__campaign__';

export type DeliveryPayload =
  | { preview: true; messages: Array<Record<string, unknown>>; to?: undefined }
  | { preview: false; to: string; messages: Array<Record<string, unknown>> };

/**
 * Creates the exact body used by both the mock and live adapters.
 * A real recipient runs the full live validation; the preview recipient is
 * only reachable in DRY_RUN because the live adapter rejects preview payloads.
 */
export function buildDeliveryPayload(input: { recipientKey: string; flexMessage: unknown }): DeliveryPayload {
  if (input.recipientKey === PREVIEW_RECIPIENT) {
    const flex = assertFlexJson(input.flexMessage);
    if (typeof flex.altText !== 'string' || flex.altText.trim().length === 0) {
      throw new Error('Flex message altText must not be empty');
    }
    return { preview: true, messages: [structuredClone(flex)] };
  }
  const body = buildLivePushBody({ lineUserId: input.recipientKey, flexMessage: input.flexMessage });
  return { preview: false, to: body.to, messages: body.messages };
}

/**
 * Creates a single-recipient LINE Messaging API push body.
 *
 * The worker still enforces OA/provider identity, consent and opt-out,
 * campaign approval, quota, kill switches, frozen revision,
 * per-recipient idempotency, and the explicit LIVE release gate before
 * this body reaches a transport. No network operations occur here.
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

/** LINE caps a single text message at 5000 characters. */
export const MANUAL_PUSH_TEXT_MAX_CHARS = 5000;

export type ManualTextPushBody = { to: string; messages: Array<{ type: 'text'; text: string }> };

/**
 * Single-recipient text push used by the manual "ส่งข้อความตรง" screen.
 * Consent, kill switches and the LIVE release gate are enforced by the route,
 * exactly like the campaign pipeline. No network operations occur here.
 */
export function buildManualTextPushBody(input: { lineUserId: unknown; text: unknown }): ManualTextPushBody {
  const userId = input.lineUserId;
  if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/i.test(userId)) {
    throw new Error('recipient must be a LINE userId (U followed by 32 hex characters)');
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('message text must not be empty');
  if ([...text].length > MANUAL_PUSH_TEXT_MAX_CHARS) {
    throw new Error(`message text must not exceed ${MANUAL_PUSH_TEXT_MAX_CHARS} characters`);
  }
  return { to: userId, messages: [{ type: 'text', text }] };
}

/**
 * A Flex card pushed to one recipient from the manual screen. The document rules are
 * the campaign rules (assertFlexJson), only the error wording is aimed at someone
 * typing in a browser, because the same screen is used to share a card with a friend.
 */
export function buildManualFlexPushBody(input: { lineUserId: unknown; flexMessage: unknown }): { to: string; messages: Array<Record<string, unknown>> } {
  const userId = input.lineUserId;
  if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/i.test(userId)) {
    throw new Error('recipient must be a LINE userId (U followed by 32 hex characters)');
  }
  const flex = assertFlexJson(input.flexMessage);
  if (typeof flex.altText !== 'string' || flex.altText.trim().length === 0) {
    throw new Error('a Flex card needs altText — the short line shown in the notification');
  }
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
