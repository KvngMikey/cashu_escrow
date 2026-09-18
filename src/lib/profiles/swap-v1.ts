/**
 * Supplies what the kernel refuses to know: the terms schema, the roles
 * derived from `direction`, the deadlines, and the authorization table for
 * every action. Nothing here moves funds or decides release policy.
 */

import { z } from 'zod';

import {
  Commitment,
  RESOLUTION_EFFECTS,
  type ResolutionEffect,
} from '../pontmore/kinds.ts';
import type {
  AuthorizeInput,
  ChainFacts,
  ProfileAdapter,
  ProfileResult,
  ValidatedRoot,
} from '../pontmore/chain.ts';
import type { Participant } from '../pontmore/kinds.ts';
import {
  DecimalAmountString,
  OpaqueRef,
  SatAmountString,
  UnixSeconds,
} from '../primitives.ts';

export const PROFILE_ID = 'pontmore/swap@1' as const;
export const ROLE_AGENT = 'swap/agent' as const;
export const ROLE_CUSTOMER = 'swap/customer' as const;
export const ACTION_FIAT_SENT = 'swap/fiat_sent' as const;
export const ACTION_FIAT_CONFIRMED = 'swap/fiat_confirmed' as const;

export const DIRECTIONS = ['fiat_to_btc', 'btc_to_fiat'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Dispute classes the profile names. A class is a routing claim, not proof. */
export const DISPUTE_CLASSES = [
  'fiat_not_received',
  'incorrect_fiat_amount',
  'payment_reference_invalid',
  'escrow_not_secured',
  'bitcoin_not_released',
  'conflicting_confirmation',
  'timeout',
] as const;

export const SwapTerms = z
  .object({
    direction: z.enum(DIRECTIONS),
    fiat: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 code'),
        amount: DecimalAmountString,
      })
      .strict(),
    bitcoin: z
      .object({
        amount: SatAmountString,
        unit: z.literal('sat'),
        network: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
      })
      .strict(),
    payment_channel: z.string().regex(/^[a-z0-9][a-z0-9_-]*@[1-9][0-9]*$/),
    deadlines: z
      .object({ fiat_pay_by: UnixSeconds, fiat_confirm_by: UnixSeconds })
      .strict(),
  })
  .strict();
export type SwapTerms = z.infer<typeof SwapTerms>;

/** A safe opaque identifier, or a versioned commitment to the real reference. */
export const PaymentReference = z.union([OpaqueRef, Commitment]);
export type PaymentReference = z.infer<typeof PaymentReference>;

const PaymentActionData = z
  .object({ payment_reference: PaymentReference })
  .strict();

export type SwapFacts = {
  fiatSent: { signer: string; reference: PaymentReference } | null;
  fiatConfirmed: { signer: string; reference: PaymentReference } | null;
};

/** The four economic roles, selected from the two bound application keys. */
export type DerivedRoles = {
  fiatSender: string;
  fiatReceiver: string;
  bitcoinProvider: string;
  bitcoinRecipient: string;
};

/**
 * Who bears the operator fee: the party the sats leave the escrow towards.
 * The amount is `fees.ts`'s business alone, this only names the party.
 */
export function feeBearer(roles: DerivedRoles): string {
  return roles.bitcoinRecipient;
}

export function deriveRoles(
  direction: Direction,
  agent: string,
  customer: string
): DerivedRoles {
  return direction === 'fiat_to_btc'
    ? {
        fiatSender: customer,
        fiatReceiver: agent,
        bitcoinProvider: agent,
        bitcoinRecipient: customer,
      }
    : {
        fiatSender: agent,
        fiatReceiver: customer,
        bitcoinProvider: customer,
        bitcoinRecipient: agent,
      };
}

const ok = <T>(value: T): ProfileResult<T> => ({ ok: true, value });
const no = <T>(reason: Parameters<typeof rejection>[0]): ProfileResult<T> =>
  rejection(reason);

function rejection<T>(
  reason:
    | 'terms_invalid'
    | 'descriptor_network'
    | 'expiry_ordering'
    | 'participant_roles'
    | 'unauthorized_signer'
    | 'precondition'
    | 'deadline_passed'
    | 'payment_reference_mismatch'
    | 'action_data'
): ProfileResult<T> {
  return { ok: false, reason };
}

const pubkeyOf = <T>(root: ValidatedRoot<T>, role: string): string =>
  root.participants.get(role)?.pubkey ?? '';

function rolesOf(root: ValidatedRoot<SwapTerms>): DerivedRoles {
  return deriveRoles(
    root.terms.direction,
    pubkeyOf(root, ROLE_AGENT),
    pubkeyOf(root, ROLE_CUSTOMER)
  );
}

const isApplicationParticipant = (
  root: ValidatedRoot<SwapTerms>,
  signer: string
): boolean =>
  signer === pubkeyOf(root, ROLE_AGENT) ||
  signer === pubkeyOf(root, ROLE_CUSTOMER);

function sameReference(a: PaymentReference, b: PaymentReference): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.algorithm === b.algorithm && a.digest === b.digest;
}

function parsePaymentData(data: unknown): ProfileResult<PaymentReference> {
  const parsed = PaymentActionData.safeParse(data);
  return parsed.success ? ok(parsed.data.payment_reference) : no('action_data');
}

export const swapV1: ProfileAdapter<SwapTerms, SwapFacts> = {
  id: PROFILE_ID,
  permitsDisputes: true,
  applicationRoles: [ROLE_AGENT, ROLE_CUSTOMER],
  commitmentKeys: ['private_terms', 'quote'],
  actions: [ACTION_FIAT_SENT, ACTION_FIAT_CONFIRMED],

  initialFacts: () => ({ fiatSent: null, fiatConfirmed: null }),

  parseTerms(input): ProfileResult<SwapTerms> {
    const parsed = SwapTerms.safeParse(input.terms);
    if (!parsed.success) return no('terms_invalid');
    if (!input.descriptor.networks.includes(parsed.data.bitcoin.network))
      return no('descriptor_network');

    const { fiat_pay_by: payBy, fiat_confirm_by: confirmBy } =
      parsed.data.deadlines;
    // Acceptance closes before payment may start, payment before confirmation.
    if (!(input.expiresAt < payBy && payBy < confirmBy))
      return no('expiry_ordering');

    // The proposer is one of the two application participants.
    if (!isProposerBound(input.proposer, input.participants))
      return no('participant_roles');

    return ok(parsed.data);
  },

  authorize(input): ProfileResult<SwapFacts> {
    return authorizeSwap(input);
  },

  label(facts) {
    if (facts.profile.fiatConfirmed !== null) return 'fiat_confirmed';
    if (facts.profile.fiatSent !== null) return 'fiat_sent';
    return null;
  },
};

function isProposerBound(
  proposer: string,
  participants: ReadonlyMap<string, Participant>
): boolean {
  return (
    participants.get(ROLE_AGENT)?.pubkey === proposer ||
    participants.get(ROLE_CUSTOMER)?.pubkey === proposer
  );
}

function authorizeSwap(
  input: AuthorizeInput<SwapTerms, SwapFacts>
): ProfileResult<SwapFacts> {
  const { root, facts, action, signer, at } = input;
  const profileFacts = facts.profile;
  const roles = rolesOf(root);
  const deadlines = root.terms.deadlines;

  switch (action) {
    case 'core/accept': {
      if (signer === root.proposer || !isApplicationParticipant(root, signer)) {
        return no('unauthorized_signer');
      }
      if (at >= root.content.expires_at) return no('deadline_passed');
      return ok(profileFacts);
    }

    case 'core/decline': {
      if (signer === root.proposer || !isApplicationParticipant(root, signer)) {
        return no('unauthorized_signer');
      }
      if (facts.accepted) return no('precondition');
      return ok(profileFacts);
    }

    case 'core/cancel': {
      if (!facts.accepted) {
        if (signer !== root.proposer) return no('unauthorized_signer');
        return ok(profileFacts);
      }
      if (!isApplicationParticipant(root, signer))
        return no('unauthorized_signer');
      if (facts.secured) return no('precondition');
      return ok(profileFacts);
    }

    case 'core/expire': {
      if (!isApplicationParticipant(root, signer))
        return no('unauthorized_signer');
      if (facts.accepted || at <= root.content.expires_at)
        return no('precondition');
      return ok(profileFacts);
    }

    case ACTION_FIAT_SENT: {
      if (signer !== roles.fiatSender) return no('unauthorized_signer');
      if (!facts.secured) return no('precondition');
      if (at >= deadlines.fiat_pay_by) return no('deadline_passed');
      const reference = parsePaymentData(input.data);
      if (!reference.ok) return reference;
      return ok({
        ...profileFacts,
        fiatSent: { signer, reference: reference.value },
      });
    }

    case ACTION_FIAT_CONFIRMED: {
      if (signer !== roles.fiatReceiver) return no('unauthorized_signer');
      const sent = profileFacts.fiatSent;
      if (sent === null) return no('precondition');
      if (at >= deadlines.fiat_confirm_by) return no('deadline_passed');
      const reference = parsePaymentData(input.data);
      if (!reference.ok) return reference;
      // The confirmation must name the payment the sender claimed.
      if (!sameReference(sent.reference, reference.value)) {
        return no('payment_reference_mismatch');
      }
      return ok({
        ...profileFacts,
        fiatConfirmed: { signer, reference: reference.value },
      });
    }

    case 'core/authorize_settlement': {
      if (signer !== roles.fiatReceiver) return no('unauthorized_signer');
      const confirmed = profileFacts.fiatConfirmed;
      if (confirmed === null || confirmed.signer !== signer)
        return no('precondition');
      return ok(profileFacts);
    }

    case 'core/authorize_refund': {
      if (signer !== roles.bitcoinProvider) return no('unauthorized_signer');
      if (!facts.secured) return no('precondition');
      // Only once the payment window closed with nothing claimed sent.
      if (at <= deadlines.fiat_pay_by || profileFacts.fiatSent !== null) {
        return no('precondition');
      }
      return ok(profileFacts);
    }

    case 'core/open_dispute': {
      if (!isApplicationParticipant(root, signer))
        return no('unauthorized_signer');
      if (!facts.accepted) return no('precondition');
      const disputeClass = (input.data as { class?: string }).class;
      if (
        disputeClass !== undefined &&
        !(DISPUTE_CLASSES as readonly string[]).includes(disputeClass)
      )
        return no('action_data');
      return ok(profileFacts);
    }

    case 'core/resolve_dispute': {
      const effect = (input.data as { effect?: ResolutionEffect }).effect;
      if (effect === undefined || !RESOLUTION_EFFECTS.includes(effect)) {
        return no('action_data');
      }
      return ok(profileFacts);
    }

    // `core/secure`, `core/settle`, `core/refund`: the kernel has already
    // checked the escrow authority and the ordering invariants.
    default:
      return ok(profileFacts);
  }
}

export type SwapChainFacts = ChainFacts<SwapFacts>;
