import { describe, expect, it } from 'vitest';
import { normalizeOsmElement } from '../src/providers/osm-overpass-adapter';

describe('normalizeOsmElement', () => {
  it('maps a tourism=attraction node to category attraction', () => {
    const result = normalizeOsmElement({
      type: 'node',
      id: 123,
      lat: 28.6139,
      lon: 77.209,
      tags: { name: 'India Gate', tourism: 'attraction' },
    });

    expect(result).toEqual({
      externalRef: 'osm:node/123',
      name: 'India Gate',
      category: 'attraction',
      latitude: 28.6139,
      longitude: 77.209,
      raw: { name: 'India Gate', tourism: 'attraction' },
    });
  });

  it('maps amenity=restaurant to category restaurant', () => {
    const result = normalizeOsmElement({
      type: 'node',
      id: 124,
      lat: 28.65,
      lon: 77.23,
      tags: { name: "Karim's", amenity: 'restaurant' },
    });

    expect(result?.category).toBe('restaurant');
  });

  it('maps any shop=* tag to category shop', () => {
    const result = normalizeOsmElement({
      type: 'node',
      id: 125,
      lat: 28.65,
      lon: 77.23,
      tags: { name: 'Chandni Chowk Textiles', shop: 'clothes' },
    });

    expect(result?.category).toBe('shop');
  });

  it('returns null when the element has no name', () => {
    const result = normalizeOsmElement({
      type: 'node',
      id: 126,
      lat: 28.65,
      lon: 77.23,
      tags: { tourism: 'attraction' },
    });

    expect(result).toBeNull();
  });

  it('returns null when no recognized category tag is present', () => {
    const result = normalizeOsmElement({
      type: 'node',
      id: 127,
      lat: 28.65,
      lon: 77.23,
      tags: { name: 'Some Building', building: 'yes' },
    });

    expect(result).toBeNull();
  });

  it('falls back to the center point for a way/relation', () => {
    const result = normalizeOsmElement({
      type: 'way',
      id: 128,
      center: { lat: 28.66, lon: 77.24 },
      tags: { name: 'Red Fort', tourism: 'attraction' },
    });

    expect(result).toMatchObject({ latitude: 28.66, longitude: 77.24 });
  });
});
