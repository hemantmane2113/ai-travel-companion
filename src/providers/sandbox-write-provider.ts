import { randomUUID } from 'crypto';
import type { BookingConfirmation, CancellationConfirmation, PreparedBooking, WriteProvider } from './write-provider';

export interface SandboxWriteProviderOptions {
  /**
   * offerIds that must deterministically fail execution - a test-only
   * hook (never set by production config in src/http/core.module.ts) so
   * failure/idempotency-after-failure behavior can be proven without any
   * randomness. Never used to decide anything about a real offer's
   * actual bookability.
   */
  failOfferIds?: Iterable<string>;
  /** providerBookingRefs that must deterministically fail cancellation - the same test-only hook as failOfferIds, applied to Phase 8's cancel(). */
  failCancellationForRefs?: Iterable<string>;
}

/**
 * The sandbox WriteProvider (V2 architecture Phase 7/§E - the document's
 * own Phase 8): a deterministic, in-process implementation that never
 * contacts a real external booking service - CLAUDE.md §25's "mocked/
 * sandbox/real" distinction is never hidden: `providerName` always
 * identifies this as the sandbox, and no code anywhere presents its
 * results as a real commercial booking.
 *
 * Provider-side idempotency (plan §I, second guard - distinct from the
 * Booking Agent's own DB-level "our-side" guard): `execute()` is keyed
 * by the caller-supplied idempotency key. A second `execute()` call with
 * a key that already has a recorded confirmation returns the EXACT same
 * confirmation (same `providerBookingRef`) rather than creating a new
 * booking - simulating what a real provider's idempotency-key contract
 * is supposed to guarantee, so the Booking Agent's retry-recovery logic
 * can be proven deterministically without a real provider.
 */
export class SandboxWriteProvider implements WriteProvider {
  readonly providerName = 'SandboxWriteProvider';

  private readonly failOfferIds: Set<string>;
  private readonly failCancellationForRefs: Set<string>;
  private readonly confirmationsByIdempotencyKey = new Map<string, BookingConfirmation>();
  private readonly cancellationsByIdempotencyKey = new Map<string, CancellationConfirmation>();

  constructor(options: SandboxWriteProviderOptions = {}) {
    this.failOfferIds = new Set(options.failOfferIds ?? []);
    this.failCancellationForRefs = new Set(options.failCancellationForRefs ?? []);
  }

  async prepare(_offerId: string): Promise<PreparedBooking> {
    // Not used in Phase 7: the Booking Agent consumes the already-persisted
    // PreparedBooking snapshot from the confirmed booking intent (plan
    // §I's "prepare" step already happened, deterministically, in Phase 6's
    // createBookingIntent - re-preparing through a provider call here would
    // be exactly the "fresh search to execute" this phase must not do).
    // Left unimplemented rather than fabricating a quote, matching
    // CLAUDE.md §17's "never hide a provider failure behind a fabricated
    // response" - a caller that mistakenly invokes this gets an honest
    // error, not invented data.
    throw new Error('SandboxWriteProvider.prepare is not implemented in Phase 7 - the Booking Agent does not call it.');
  }

  async execute(prepared: PreparedBooking, idempotencyKey: string): Promise<BookingConfirmation> {
    const existing = this.confirmationsByIdempotencyKey.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    if (this.failOfferIds.has(prepared.offerId)) {
      throw new Error(`SandboxWriteProvider: simulated execution failure for offer ${prepared.offerId}`);
    }

    const confirmation: BookingConfirmation = {
      executionState: 'confirmed',
      providerBookingRef: `sandbox-booking-${randomUUID()}`,
    };
    this.confirmationsByIdempotencyKey.set(idempotencyKey, confirmation);
    return confirmation;
  }

  async getStatus(idempotencyKey: string): Promise<BookingConfirmation> {
    const existing = this.confirmationsByIdempotencyKey.get(idempotencyKey);
    if (existing) return existing;
    return { executionState: 'not_executed', providerBookingRef: null };
  }

  async cancel(providerBookingRef: string, idempotencyKey: string): Promise<CancellationConfirmation> {
    const existing = this.cancellationsByIdempotencyKey.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    if (this.failCancellationForRefs.has(providerBookingRef)) {
      throw new Error(`SandboxWriteProvider: simulated cancellation failure for booking ${providerBookingRef}`);
    }

    const confirmation: CancellationConfirmation = {
      executionState: 'confirmed',
      cancellationRef: `sandbox-cancellation-${randomUUID()}`,
    };
    this.cancellationsByIdempotencyKey.set(idempotencyKey, confirmation);
    return confirmation;
  }

  async getCancellationStatus(idempotencyKey: string): Promise<CancellationConfirmation> {
    const existing = this.cancellationsByIdempotencyKey.get(idempotencyKey);
    if (existing) return existing;
    return { executionState: 'not_executed', cancellationRef: null };
  }
}
