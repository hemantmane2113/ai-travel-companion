import { describe, expect, it } from 'vitest';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';

describe('SandboxWriteProvider cancellation (Phase 8)', () => {
  it('deterministically cancels a booking reference with a stable cancellation reference', async () => {
    const provider = new SandboxWriteProvider();
    const confirmation = await provider.cancel('sandbox-booking-abc', 'cancel-idem-1');

    expect(confirmation.executionState).toBe('confirmed');
    expect(confirmation.cancellationRef).toBeTruthy();

    const status = await provider.getCancellationStatus('cancel-idem-1');
    expect(status).toEqual(confirmation);
  });

  it('idempotency: a second cancel() with the same key returns the exact same confirmation', async () => {
    const provider = new SandboxWriteProvider();
    const first = await provider.cancel('sandbox-booking-abc', 'cancel-idem-2');
    const second = await provider.cancel('sandbox-booking-abc', 'cancel-idem-2');

    expect(second).toEqual(first);
  });

  it('deterministically fails cancellation for a configured providerBookingRef, never fabricating success', async () => {
    const provider = new SandboxWriteProvider({ failCancellationForRefs: ['sandbox-booking-fail'] });
    await expect(provider.cancel('sandbox-booking-fail', 'cancel-idem-3')).rejects.toThrow(/simulated cancellation failure/);
  });

  it('a failed cancel() leaves no confirmation recorded - a later getCancellationStatus reports not_executed', async () => {
    const provider = new SandboxWriteProvider({ failCancellationForRefs: ['sandbox-booking-fail'] });
    await expect(provider.cancel('sandbox-booking-fail', 'cancel-idem-4')).rejects.toThrow();

    const status = await provider.getCancellationStatus('cancel-idem-4');
    expect(status).toEqual({ executionState: 'not_executed', cancellationRef: null });
  });

  it('getCancellationStatus for a never-attempted key reports not_executed rather than guessing', async () => {
    const provider = new SandboxWriteProvider();
    const status = await provider.getCancellationStatus('never-attempted-cancel-key');
    expect(status).toEqual({ executionState: 'not_executed', cancellationRef: null });
  });

  it('booking execution and cancellation idempotency caches are independent - a shared key namespace never collides', async () => {
    const provider = new SandboxWriteProvider();
    const bookingConfirmation = await provider.execute(
      {
        offerId: 'offer-1',
        provider: 'MockAgoda',
        domain: 'hotel',
        price: 100,
        currency: 'INR',
        cancellationPolicy: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      'shared-key',
    );
    const cancellationConfirmation = await provider.cancel('sandbox-booking-xyz', 'shared-key');

    expect(bookingConfirmation.providerBookingRef).not.toBe(cancellationConfirmation.cancellationRef);
    // getStatus (booking) and getCancellationStatus (cancellation) each
    // resolve their own confirmation for the same key, independently.
    expect((await provider.getStatus('shared-key')).providerBookingRef).toBe(bookingConfirmation.providerBookingRef);
    expect((await provider.getCancellationStatus('shared-key')).cancellationRef).toBe(cancellationConfirmation.cancellationRef);
  });
});
