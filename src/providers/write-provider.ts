import type { Domain } from './hotel-provider';

/**
 * The write side of the read/write provider split (V2 architecture
 * Phase 6/§E): `HotelProvider`/`FlightProvider`/`TrainProvider`/
 * `BusProvider` are all ReadProvider-only today - none of them (and no
 * class anywhere in this codebase) implements this interface. It exists
 * purely to define the boundary a future real/sandbox WriteProvider
 * will implement, per the explicit instruction: "define the abstraction
 * only; provide no real implementation that performs an external
 * write." A mock that pretended to book something would misrepresent
 * what actually happened, which this architecture treats as a trust
 * violation (CLAUDE.md §17/§25) - so there is deliberately no
 * `MockWriteProvider` class.
 */
export interface PreparedBooking {
  offerId: string;
  provider: string;
  domain: Domain;
  price: number;
  currency: string;
  cancellationPolicy: string | null;
  /** ISO 8601 - when this prepared snapshot expires and must be re-verified before booking. */
  expiresAt: string;
}

export type BookingExecutionState = 'not_executed' | 'unknown' | 'confirmed';

export interface BookingConfirmation {
  executionState: BookingExecutionState;
  providerBookingRef: string | null;
}

/** The write side's cancellation outcome (V2 architecture Phase 8/§5.8) - deliberately its own type, not a reuse of BookingExecutionState/BookingConfirmation, since a cancellation confirmation is a distinct provider operation with its own reference (`cancellationRef`, not a booking ref). */
export type CancellationExecutionState = 'not_executed' | 'unknown' | 'confirmed';

export interface CancellationConfirmation {
  executionState: CancellationExecutionState;
  /** The provider's own cancellation confirmation reference, if it issues one - distinct from a booking's own providerBookingRef. */
  cancellationRef: string | null;
}

export interface WriteProvider {
  readonly providerName: string;
  /** Re-verifies price/availability with the provider and returns a fresh, bookable snapshot (plan §I: "show final price/details, re-verify against provider"). */
  prepare(offerId: string): Promise<PreparedBooking>;
  /** Executes the actual write. Accepts a caller-supplied idempotency key so a retried call against an ambiguous prior attempt reuses it rather than risking a duplicate booking (plan §I). */
  execute(prepared: PreparedBooking, idempotencyKey: string): Promise<BookingConfirmation>;
  /** Resolves an ambiguous/timed-out execute before any retry - never blindly retry a write (plan §I). */
  getStatus(idempotencyKey: string): Promise<BookingConfirmation>;
  /**
   * Cancels an existing provider booking, identified by its own
   * `providerBookingRef` (V2 architecture Phase 8/§5.8). Accepts its own
   * caller-supplied idempotency key - distinct from the original
   * booking's key, since cancellation is a separate operation with its
   * own retry-safety requirement (plan §I's idempotency discipline
   * applies symmetrically to every write, not just booking creation).
   */
  cancel(providerBookingRef: string, idempotencyKey: string): Promise<CancellationConfirmation>;
  /** Resolves an ambiguous/timed-out cancel before any retry - the cancellation-side mirror of getStatus. */
  getCancellationStatus(idempotencyKey: string): Promise<CancellationConfirmation>;
}
