import { describe, expect, it } from 'vitest';
import { parseTripDuration } from '../src/itinerary/trip-dates';

describe('parseTripDuration', () => {
  it('computes 1 day for a same-day trip (inclusive range)', () => {
    expect(parseTripDuration('2026-10-01', '2026-10-01')).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      numberOfDays: 1,
    });
  });

  it('computes 2 days for a 1-night trip', () => {
    expect(parseTripDuration('2026-10-01', '2026-10-02').numberOfDays).toBe(2);
  });

  it('computes 3 days correctly', () => {
    expect(parseTripDuration('2026-10-01', '2026-10-03').numberOfDays).toBe(3);
  });

  it('throws when endDate is before startDate', () => {
    expect(() => parseTripDuration('2026-10-05', '2026-10-01')).toThrow(
      /endDate must not be before startDate/,
    );
  });

  it('throws when the trip duration exceeds the reasonable maximum', () => {
    expect(() => parseTripDuration('2026-10-01', '2026-11-01')).toThrow(/exceeds the maximum/);
  });

  it('throws for a malformed date string', () => {
    expect(() => parseTripDuration('not-a-date', '2026-10-02')).toThrow(/Invalid date/);
  });
});
