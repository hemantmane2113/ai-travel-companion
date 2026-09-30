import { describe, expect, it } from 'vitest';
import { haversineDistanceKm } from '../src/geo';

describe('haversineDistanceKm', () => {
  it('returns 0 for identical points', () => {
    const point = { latitude: 28.6315, longitude: 77.2167 };
    expect(haversineDistanceKm(point, point)).toBe(0);
  });

  it('returns a plausible distance between two known Delhi landmarks', () => {
    // Connaught Place -> Red Fort is roughly 4-5 km in a straight line.
    const connaughtPlace = { latitude: 28.6315, longitude: 77.2167 };
    const redFort = { latitude: 28.6562, longitude: 77.241 };

    const distance = haversineDistanceKm(connaughtPlace, redFort);

    expect(distance).toBeGreaterThan(2);
    expect(distance).toBeLessThan(7);
  });

  it('is symmetric', () => {
    const a = { latitude: 28.6315, longitude: 77.2167 };
    const b = { latitude: 28.5, longitude: 77.1 };
    expect(haversineDistanceKm(a, b)).toBeCloseTo(haversineDistanceKm(b, a), 10);
  });
});
