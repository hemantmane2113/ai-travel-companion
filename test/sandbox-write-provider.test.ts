import { describe, expect, it } from 'vitest';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';
import type { PreparedBooking } from '../src/providers/write-provider';

function makePrepared(overrides: Partial<PreparedBooking> = {}): PreparedBooking {
  return {
    offerId: 'mock-hotel-1',
    provider: 'MockAgoda',
    domain: 'hotel',
    price: 5000,
    currency: 'INR',
    cancellationPolicy: 'Free cancellation until 24 hours before check-in',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('SandboxWriteProvider', () => {
  it('never contacts a real external service and identifies itself as the sandbox', () => {
    const provider = new SandboxWriteProvider();
    expect(provider.providerName).toBe('SandboxWriteProvider');
  });

  it('deterministically creates a booking with a stable external reference across a getStatus lookup', async () => {
    const provider = new SandboxWriteProvider();
    const prepared = makePrepared();

    const confirmation = await provider.execute(prepared, 'idem-key-1');
    expect(confirmation.executionState).toBe('confirmed');
    expect(confirmation.providerBookingRef).toBeTruthy();

    const status = await provider.getStatus('idem-key-1');
    expect(status).toEqual(confirmation);
  });

  it('idempotency: a second execute() with the same key returns the exact same confirmation, never a new booking', async () => {
    const provider = new SandboxWriteProvider();
    const prepared = makePrepared();

    const first = await provider.execute(prepared, 'idem-key-2');
    const second = await provider.execute(prepared, 'idem-key-2');

    expect(second).toEqual(first);
    expect(second.providerBookingRef).toBe(first.providerBookingRef);
  });

  it('different idempotency keys produce different bookings, even for the same offer', async () => {
    const provider = new SandboxWriteProvider();
    const prepared = makePrepared();

    const first = await provider.execute(prepared, 'idem-key-3a');
    const second = await provider.execute(prepared, 'idem-key-3b');

    expect(first.providerBookingRef).not.toBe(second.providerBookingRef);
  });

  it('deterministically fails execution for a configured offerId, never fabricating a success', async () => {
    const provider = new SandboxWriteProvider({ failOfferIds: ['mock-hotel-2'] });
    const prepared = makePrepared({ offerId: 'mock-hotel-2' });

    await expect(provider.execute(prepared, 'idem-key-4')).rejects.toThrow(/simulated execution failure/);
  });

  it('a failed execute() leaves no confirmation recorded - a later getStatus reports not_executed', async () => {
    const provider = new SandboxWriteProvider({ failOfferIds: ['mock-hotel-2'] });
    const prepared = makePrepared({ offerId: 'mock-hotel-2' });

    await expect(provider.execute(prepared, 'idem-key-5')).rejects.toThrow();

    const status = await provider.getStatus('idem-key-5');
    expect(status).toEqual({ executionState: 'not_executed', providerBookingRef: null });
  });

  it('getStatus for a never-attempted key reports not_executed rather than guessing', async () => {
    const provider = new SandboxWriteProvider();
    const status = await provider.getStatus('never-attempted-key');
    expect(status).toEqual({ executionState: 'not_executed', providerBookingRef: null });
  });

  it('prepare() is honestly unimplemented in this phase rather than fabricating a quote', async () => {
    const provider = new SandboxWriteProvider();
    await expect(provider.prepare('any-offer-id')).rejects.toThrow(/not implemented in Phase 7/);
  });
});
