// Not a hard product requirement from anyone - a placeholder sanity cap
// so a malformed or joke date range (e.g. a 10-year "trip") can't
// silently create thousands of itinerary_days rows. Trivial to change.
const MAX_TRIP_DAYS = 14;

export interface TripDuration {
  startDate: string;
  endDate: string;
  numberOfDays: number;
}

function parseIsoDate(value: string): Date {
  // DTO-layer @IsDateString() already rejects non-ISO strings before this
  // runs in the HTTP path; this parse is defensive for any other caller
  // (CLI, tests) that skips the DTO.
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Establishes the correct data flow for multi-day trips (plan
 * stabilization P0-4) - deliberately just date-range validation and a
 * day count, not trip-length optimization. Both dates are inclusive:
 * startDate === endDate is a valid 1-day trip.
 */
export function parseTripDuration(startDate: string, endDate: string): TripDuration {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);

  if (end.getTime() < start.getTime()) {
    throw new Error('endDate must not be before startDate');
  }

  const numberOfDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;

  if (numberOfDays > MAX_TRIP_DAYS) {
    throw new Error(`Trip duration of ${numberOfDays} days exceeds the maximum of ${MAX_TRIP_DAYS}`);
  }

  return { startDate, endDate, numberOfDays };
}
