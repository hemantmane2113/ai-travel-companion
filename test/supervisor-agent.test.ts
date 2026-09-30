import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { routeMessage } from '../src/agents/supervisor-agent';
import { listMessages, createConversation } from '../src/companion/conversations';
import { ingestPlaces } from '../src/ingestion/ingest-places';
import { getJob } from '../src/itinerary/jobs';
import { FakeLlmProvider } from '../src/ai/fake-llm-provider';
import { SandboxWriteProvider } from '../src/providers/sandbox-write-provider';
import { DESTINATIONS } from '../src/destinations';
import type { BoundingBox, NormalizedPlace, PlacesProvider } from '../src/providers/places-provider';
import { deleteItineraryAndJob, deletePlacesByExternalRef, deleteBookingsByTaskIds } from './helpers/db-cleanup';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

class FixturePlacesProvider implements PlacesProvider {
  readonly sourceName = 'Fixture';
  constructor(private readonly places: NormalizedPlace[]) {}
  async search(_bbox: BoundingBox): Promise<NormalizedPlace[]> {
    return this.places;
  }
}

const TEST_PREFIX = 'test:supervisor-agent';
const { bbox, center } = DESTINATIONS.delhi;
const START_DATE = '2026-10-01';
const END_DATE = '2026-10-01';

const RED_FORT: NormalizedPlace = {
  externalRef: `${TEST_PREFIX}:attraction:0`,
  name: 'Red Fort',
  category: 'attraction',
  latitude: center.latitude,
  longitude: center.longitude + 0.01,
  raw: {},
};

function noopLlm(): FakeLlmProvider {
  // The Q&A route never calls the LLM at all (§ answer-question.ts) -
  // this stand-in exists only so routeMessage's signature is satisfied;
  // if it were ever invoked by the Q&A path these tests would need to
  // supply a real response, which is itself a useful regression signal.
  return new FakeLlmProvider('THIS SHOULD NEVER BE CALLED FOR A Q&A REQUEST');
}

describe('routeMessage (Supervisor Agent)', () => {
  it('routes a full-trip request (destinationSlug + dates supplied) to the Planning Agent, which reaches the existing itinerary pipeline unchanged', async () => {
    const provider = new FixturePlacesProvider([RED_FORT]);
    await ingestPlaces(pool, provider, 'delhi', bbox);

    const factRow = await pool.query(
      `select f.current_version_id as fact_version_id
       from places p join facts f on f.entity_table = 'places' and f.entity_id = p.id and f.fact_type = 'place_listing'
       where p.external_ref = $1`,
      [RED_FORT.externalRef],
    );
    const placeRow = await pool.query('select id from places where external_ref = $1', [RED_FORT.externalRef]);
    const factVersionId = factRow.rows[0].fact_version_id;
    const placeId = placeRow.rows[0].id;

    const llm = new FakeLlmProvider(
      JSON.stringify({
        summary: 'A day in Delhi.',
        days: [
          {
            dayNumber: 1,
            summary: 'History.',
            items: [{ itemType: 'place', placeId, reason: 'A must-see fort.', factReferences: [factVersionId] }],
          },
        ],
      }),
    );

    let result: Awaited<ReturnType<typeof routeMessage>> | undefined;
    try {
      result = await routeMessage(pool, llm, {
        message: 'I am visiting Delhi for 3 days. Plan a trip for me.',
        destinationSlug: 'delhi',
        interests: ['history'],
        startDate: START_DATE,
        endDate: END_DATE,
      });

      expect(result.route).toBe('full_trip');
      if (result.route !== 'full_trip') throw new Error('unreachable');

      // Poll, same as a real client would (fire-and-forget async job -
      // identical mechanism to POST /itineraries, unmodified).
      let job;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        job = await getJob(pool, result.jobId);
        if (job?.status === 'complete' || job?.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(job?.status).toBe('complete');
      expect(job?.itineraryId).toBeTruthy();

      const messages = await listMessages(pool, result.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].structuredPayload).toEqual({ route: 'full_trip', jobId: result.jobId });
    } finally {
      if (result?.route === 'full_trip') {
        const job = await getJob(pool, result.jobId);
        await deleteItineraryAndJob(pool, { jobId: result.jobId, itineraryId: job?.itineraryId });
      }
      await deletePlacesByExternalRef(pool, [RED_FORT.externalRef]);
    }
  });

  it('routes a plain question to the Q&A path WITHOUT creating any itinerary job or itinerary', async () => {
    // A global COUNT(*) before/after would be racy against other test
    // files creating jobs concurrently (Vitest runs files in parallel) -
    // instead assert directly on the code path taken (route === 'qa')
    // and its persisted side effect (no jobId anywhere in the message
    // this call itself wrote), which is exact rather than a proxy.
    const result = await routeMessage(pool, noopLlm(), {
      message: 'How far is Totally Unknown Place One from Totally Unknown Place Two?',
    });

    expect(result.route).toBe('qa');
    if (result.route !== 'qa') throw new Error('unreachable');
    expect(result.answer).toMatch(/don't have location data/);
    expect('jobId' in result).toBe(false);

    const messages = await listMessages(pool, result.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Totally Unknown Place') });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: result.answer });
    expect(messages[1].structuredPayload).toEqual({ route: 'qa', matchedDestinationSlug: null });
  });

  it('continues an existing conversation instead of starting a new one when conversationId is supplied', async () => {
    const first = await routeMessage(pool, noopLlm(), { message: 'Tell me about Nowhere.' });
    const second = await routeMessage(pool, noopLlm(), {
      message: 'And what about Nowhere Else?',
      conversationId: first.conversationId,
    });

    expect(second.conversationId).toBe(first.conversationId);
    const messages = await listMessages(pool, first.conversationId);
    expect(messages).toHaveLength(4); // 2 user + 2 assistant, same thread
  });

  it('rejects a message for an unknown conversationId rather than silently creating a new thread', async () => {
    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'hello',
        conversationId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/Unknown conversation/);
  });

  it('routes a hotel-comparison request (hotelSearchLocation supplied) to the Comparison Agent', async () => {
    const result = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });

    expect(result.route).toBe('comparison');
    if (result.route !== 'comparison') throw new Error('unreachable');
    expect(result.taskId).toBeTruthy();
    expect(result.result.offers.length).toBeGreaterThan(0);
    expect(result.result.domains).toEqual(['hotel']);

    const messages = await listMessages(pool, result.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[1].structuredPayload).toMatchObject({ route: 'comparison', taskId: result.taskId });
  });

  it('a hotel-comparison message with no hotelSearchLocation does NOT route to the Comparison Agent (falls through to Q&A)', async () => {
    const result = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
    });

    expect(result.route).toBe('qa');
  });

  it('an ordinal follow-up ("I like the second one") resolves against the persisted comparison task - not a fresh search', async () => {
    const comparison = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    if (comparison.route !== 'comparison') throw new Error('unreachable');
    const secondPersistedOffer = comparison.result.offers[1];

    const followUp = await routeMessage(pool, noopLlm(), {
      message: 'I like the second one.',
      conversationId: comparison.conversationId,
    });

    expect(followUp.route).toBe('ordinal_selection');
    if (followUp.route !== 'ordinal_selection') throw new Error('unreachable');
    expect(followUp.selectedOfferId).toBe(secondPersistedOffer.offerId);
    expect(followUp.provider).toBe(secondPersistedOffer.provider);
    expect(followUp.domain).toBe('hotel');
  });

  it('an ambiguous ordinal reference (naming more than one position) is never guessed', async () => {
    const comparison = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    if (comparison.route !== 'comparison') throw new Error('unreachable');

    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'I like the first and second one.',
        conversationId: comparison.conversationId,
      }),
    ).rejects.toThrow(/not sure which option you mean/);
  });

  it('an ordinal follow-up with no prior completed comparison task in the conversation is never guessed', async () => {
    await expect(
      routeMessage(pool, noopLlm(), { message: 'I like the second one.' }),
    ).rejects.toThrow(/don't have a completed comparison/);
  });

  it('an ordinal follow-up outside the persisted result set is never guessed', async () => {
    // Force zero offers by overriding the injected hotel providers, so
    // "the first one" has nothing to resolve against.
    const comparison = await routeMessage(
      pool,
      noopLlm(),
      { message: 'Compare hotels near Karol Bagh', hotelSearchLocation: 'Karol Bagh' },
      { hotel: [] },
    );
    if (comparison.route !== 'comparison') throw new Error('unreachable');
    expect(comparison.result.offers).toEqual([]);

    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'I like the first one.',
        conversationId: comparison.conversationId,
      }),
    ).rejects.toThrow(/no option #1/);
  });

  it('routes a transport comparison request (transportOrigin/transportDestination + comparisonDomains) to the Comparison Agent', async () => {
    const result = await routeMessage(pool, noopLlm(), {
      message: 'Compare flights from Pune to Delhi',
      comparisonDomains: ['flight'],
      transportOrigin: 'Pune',
      transportDestination: 'Delhi',
    });

    expect(result.route).toBe('comparison');
    if (result.route !== 'comparison') throw new Error('unreachable');
    expect(result.result.domains).toEqual(['flight']);
    expect(result.result.offers.every((o) => o.domain === 'flight')).toBe(true);
  });

  it('routes a multi-domain comparison request (hotel + flight together) to the Comparison Agent in one call', async () => {
    const result = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels and flights for my Delhi trip',
      comparisonDomains: ['hotel', 'flight'],
      hotelSearchLocation: 'Karol Bagh',
      transportOrigin: 'Pune',
      transportDestination: 'Delhi',
    });

    expect(result.route).toBe('comparison');
    if (result.route !== 'comparison') throw new Error('unreachable');
    expect(result.result.domains).toEqual(['hotel', 'flight']);
    expect(result.result.offers.some((o) => o.domain === 'hotel')).toBe(true);
    expect(result.result.offers.some((o) => o.domain === 'flight')).toBe(true);
  });

  it('a comparisonDomains request missing required transport criteria does not guess - it errors clearly', async () => {
    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'Compare flights',
        comparisonDomains: ['flight'],
        // transportOrigin/transportDestination deliberately omitted
      }),
    ).rejects.toThrow(/requires an origin and a destination/);
  });

  it('an unsupported comparisonDomains value is rejected explicitly, never silently ignored', async () => {
    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'Compare something',
        // @ts-expect-error - deliberately invalid at the type level too; DTO-level @IsIn would also reject this over real HTTP
        comparisonDomains: ['boat'],
        transportOrigin: 'Pune',
        transportDestination: 'Delhi',
      }),
    ).rejects.toThrow(/Unsupported comparison domain/);
  });

  it('a cancellationPolicyOfferId request routes to the cancellation-policy tool and returns a known structured policy for a hotel offer', async () => {
    const comparison = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    if (comparison.route !== 'comparison') throw new Error('unreachable');
    const hotelOfferId = comparison.result.offers[0].offerId;

    const result = await routeMessage(pool, noopLlm(), {
      message: 'What is the cancellation policy?',
      conversationId: comparison.conversationId,
      cancellationPolicyOfferId: hotelOfferId,
    });

    expect(result.route).toBe('cancellation_policy');
    if (result.route !== 'cancellation_policy') throw new Error('unreachable');
    expect(result.result.status).toBe('known');
    expect(result.result.policy).toBeTruthy();
  });

  it('a cancellationPolicyOfferId for an unknown offer honestly reports unavailable rather than fabricating a policy', async () => {
    const result = await routeMessage(pool, noopLlm(), {
      message: 'What is the cancellation policy?',
      cancellationPolicyOfferId: 'totally-unknown-offer-id',
    });

    expect(result.route).toBe('cancellation_policy');
    if (result.route !== 'cancellation_policy') throw new Error('unreachable');
    expect(result.result.status).toBe('unavailable');
  });

  it('existing hotel-only comparison routing (hotelSearchLocation alone, no comparisonDomains) is unchanged from Phase 4', async () => {
    const result = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    expect(result.route).toBe('comparison');
    if (result.route !== 'comparison') throw new Error('unreachable');
    expect(result.result.domains).toEqual(['hotel']);
  });

  it('a bookingOfferId request routes to booking-intent creation, awaiting confirmation', async () => {
    const comparison = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    if (comparison.route !== 'comparison') throw new Error('unreachable');
    const offerId = comparison.result.offers[0].offerId;

    const result = await routeMessage(pool, noopLlm(), {
      message: 'I want to book this.',
      conversationId: comparison.conversationId,
      bookingOfferId: offerId,
    });

    expect(result.route).toBe('booking_intent');
    if (result.route !== 'booking_intent') throw new Error('unreachable');
    expect(result.result.bookingStatus).toBe('awaiting_confirmation');
    expect(result.result.selectedOffer.offerId).toBe(offerId);
  });

  it('saying "book this" WITHOUT the explicit confirmBookingTaskId never confirms anything - confirmation is never inferred from sentiment', async () => {
    const comparison = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    if (comparison.route !== 'comparison') throw new Error('unreachable');
    const offerId = comparison.result.offers[0].offerId;

    const intentResult = await routeMessage(pool, noopLlm(), {
      message: 'Book this hotel please, yes confirm it, go ahead.',
      conversationId: comparison.conversationId,
      bookingOfferId: offerId,
    });
    if (intentResult.route !== 'booking_intent') throw new Error('unreachable');
    // Enthusiastic free text alone never advances bookingStatus - only
    // an explicit confirmBookingTaskId on a later request can.
    expect(intentResult.result.bookingStatus).toBe('awaiting_confirmation');
  });

  it('a confirmBookingTaskId request routes to booking confirmation and transitions the exact pending intent', async () => {
    const comparison = await routeMessage(pool, noopLlm(), {
      message: 'Compare hotels near Karol Bagh',
      hotelSearchLocation: 'Karol Bagh',
    });
    if (comparison.route !== 'comparison') throw new Error('unreachable');
    const offerId = comparison.result.offers[0].offerId;

    const intent = await routeMessage(pool, noopLlm(), {
      message: 'Book this.',
      conversationId: comparison.conversationId,
      bookingOfferId: offerId,
    });
    if (intent.route !== 'booking_intent') throw new Error('unreachable');

    const confirmed = await routeMessage(pool, noopLlm(), {
      message: 'Yes, confirmed.',
      conversationId: comparison.conversationId,
      confirmBookingTaskId: intent.result.taskId,
    });

    expect(confirmed.route).toBe('booking_confirmed');
    if (confirmed.route !== 'booking_confirmed') throw new Error('unreachable');
    expect(confirmed.result.bookingStatus).toBe('confirmed');
    expect(confirmed.result.executionState).toBe('not_executed');
  });

  it('confirming an unknown booking taskId is rejected, never guessed at', async () => {
    await expect(
      routeMessage(pool, noopLlm(), {
        message: 'Yes, confirmed.',
        confirmBookingTaskId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/Unknown booking to confirm/);
  });

  describe('booking execution (Phase 7)', () => {
    const trackedTaskIds: string[] = [];
    afterAll(async () => {
      await deleteBookingsByTaskIds(pool, trackedTaskIds);
    });

    it('an executeBookingTaskId request routes to the Booking Agent and books through the configured WriteProvider', async () => {
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
      });
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Book this.',
        conversationId: comparison.conversationId,
        bookingOfferId: offerId,
      });
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      const confirmed = await routeMessage(pool, noopLlm(), {
        message: 'Yes, confirmed.',
        conversationId: comparison.conversationId,
        confirmBookingTaskId: intent.result.taskId,
      });
      if (confirmed.route !== 'booking_confirmed') throw new Error('unreachable');

      const executed = await routeMessage(
        pool,
        noopLlm(),
        {
          message: 'Execute it.',
          conversationId: comparison.conversationId,
          executeBookingTaskId: intent.result.taskId,
        },
        undefined,
        undefined,
        new SandboxWriteProvider(),
      );

      expect(executed.route).toBe('booking_executed');
      if (executed.route !== 'booking_executed') throw new Error('unreachable');
      expect(executed.result.status).toBe('booked');
      expect(executed.result.externalBookingId).toBeTruthy();
    });

    it('rejects execution when no WriteProvider is configured, rather than silently constructing an ephemeral one', async () => {
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
      });
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Book this.',
        conversationId: comparison.conversationId,
        bookingOfferId: offerId,
      });
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      await routeMessage(pool, noopLlm(), {
        message: 'Confirm it.',
        conversationId: comparison.conversationId,
        confirmBookingTaskId: intent.result.taskId,
      });

      await expect(
        routeMessage(pool, noopLlm(), {
          message: 'Execute it.',
          conversationId: comparison.conversationId,
          executeBookingTaskId: intent.result.taskId,
        }),
      ).rejects.toThrow(/No booking write provider is configured/);
    });

    it('saying "book this, confirm, execute it, go ahead" as free text never executes anything without the exact executeBookingTaskId', async () => {
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
      });
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(
        pool,
        noopLlm(),
        {
          message: 'Book this, confirm it, execute it, go ahead, I am sure, please book now.',
          conversationId: comparison.conversationId,
          bookingOfferId: offerId,
        },
        undefined,
        undefined,
        new SandboxWriteProvider(),
      );
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      // Enthusiastic free text alone never advances past 'awaiting_confirmation',
      // and therefore can never reach execution either.
      expect(intent.result.bookingStatus).toBe('awaiting_confirmation');
    });

    it('rejects executing an unconfirmed booking intent, even with a valid executeBookingTaskId', async () => {
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
      });
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Book this.',
        conversationId: comparison.conversationId,
        bookingOfferId: offerId,
      });
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      await expect(
        routeMessage(
          pool,
          noopLlm(),
          {
            message: 'Execute it.',
            conversationId: comparison.conversationId,
            executeBookingTaskId: intent.result.taskId,
          },
          undefined,
          undefined,
          new SandboxWriteProvider(),
        ),
      ).rejects.toThrow(/has not been confirmed yet/);
    });

    it('existing routes (comparison, confirm booking, create booking intent) remain unchanged by the new execute route', async () => {
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
      });
      expect(comparison.route).toBe('comparison');
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Book this.',
        conversationId: comparison.conversationId,
        bookingOfferId: offerId,
      });
      expect(intent.route).toBe('booking_intent');
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      const confirmed = await routeMessage(pool, noopLlm(), {
        message: 'Confirm it.',
        conversationId: comparison.conversationId,
        confirmBookingTaskId: intent.result.taskId,
      });
      expect(confirmed.route).toBe('booking_confirmed');
      if (confirmed.route !== 'booking_confirmed') throw new Error('unreachable');
      expect(confirmed.result.bookingStatus).toBe('confirmed');
      expect(confirmed.result.executionState).toBe('not_executed');
    });
  });

  describe('cancellation (Phase 8)', () => {
    const trackedTaskIds: string[] = [];
    afterAll(async () => {
      await deleteBookingsByTaskIds(pool, trackedTaskIds);
    });

    async function bookAHotel(conversationId: string) {
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
      });
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Book this.',
        conversationId: comparison.conversationId,
        bookingOfferId: offerId,
      });
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      await routeMessage(pool, noopLlm(), {
        message: 'Confirm it.',
        conversationId: comparison.conversationId,
        confirmBookingTaskId: intent.result.taskId,
      });

      const executed = await routeMessage(
        pool,
        noopLlm(),
        { message: 'Execute it.', conversationId: comparison.conversationId, executeBookingTaskId: intent.result.taskId },
        undefined,
        undefined,
        new SandboxWriteProvider(),
      );
      if (executed.route !== 'booking_executed') throw new Error('unreachable');
      return { conversationId: comparison.conversationId, booking: executed.result };
    }

    it('a cancelBookingId request routes to the Cancellation Agent and returns a cancellation intent', async () => {
      const { conversationId, booking } = await bookAHotel(await createConversation(pool));

      const result = await routeMessage(pool, noopLlm(), {
        message: 'Cancel my booking.',
        conversationId,
        cancelBookingId: booking.id,
      });

      expect(result.route).toBe('cancellation_intent');
      if (result.route !== 'cancellation_intent') throw new Error('unreachable');
      expect(result.result.bookingId).toBe(booking.id);
      expect(result.result.cancellationStatus).toBe('awaiting_confirmation');
    });

    it('a confirmCancellationTaskId request confirms and executes the cancellation in one route', async () => {
      const { conversationId, booking } = await bookAHotel(await createConversation(pool));

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Cancel my booking.',
        conversationId,
        cancelBookingId: booking.id,
      });
      if (intent.route !== 'cancellation_intent') throw new Error('unreachable');

      const result = await routeMessage(
        pool,
        noopLlm(),
        { message: 'Yes, confirmed.', conversationId, confirmCancellationTaskId: intent.result.taskId },
        undefined,
        undefined,
        new SandboxWriteProvider(),
      );

      expect(result.route).toBe('cancellation_executed');
      if (result.route !== 'cancellation_executed') throw new Error('unreachable');
      expect(result.result.status).toBe('cancelled');
      expect(result.result.id).toBe(booking.id);
    });

    it('saying "cancel it, yes, go ahead, please cancel, I am sure, do it" as free text never cancels anything without the exact confirmCancellationTaskId', async () => {
      const { conversationId, booking } = await bookAHotel(await createConversation(pool));

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Cancel it, yes, go ahead, please cancel, I am sure, do it.',
        conversationId,
        cancelBookingId: booking.id,
      });
      if (intent.route !== 'cancellation_intent') throw new Error('unreachable');

      expect(intent.result.cancellationStatus).toBe('awaiting_confirmation');

      const stillBooked = await routeMessage(pool, noopLlm(), {
        message: 'Cancel it, yes, go ahead, please cancel, I am sure, do it.',
        conversationId,
      });
      // No structured field at all -> falls through to Q&A, never cancels.
      expect(stillBooked.route).toBe('qa');
    });

    it('existing booking-execution routes remain unchanged by the new cancellation routes', async () => {
      const conversationId = await createConversation(pool);
      const comparison = await routeMessage(pool, noopLlm(), {
        message: 'Compare hotels near Karol Bagh',
        hotelSearchLocation: 'Karol Bagh',
        conversationId,
      });
      expect(comparison.route).toBe('comparison');
      if (comparison.route !== 'comparison') throw new Error('unreachable');
      const offerId = comparison.result.offers[0].offerId;

      const intent = await routeMessage(pool, noopLlm(), {
        message: 'Book this.',
        conversationId: comparison.conversationId,
        bookingOfferId: offerId,
      });
      expect(intent.route).toBe('booking_intent');
      if (intent.route !== 'booking_intent') throw new Error('unreachable');
      trackedTaskIds.push(intent.result.taskId);

      const confirmed = await routeMessage(pool, noopLlm(), {
        message: 'Confirm it.',
        conversationId: comparison.conversationId,
        confirmBookingTaskId: intent.result.taskId,
      });
      expect(confirmed.route).toBe('booking_confirmed');
    });
  });

  it('a knowledge-oriented question ("visa requirements") reaches Q&A, not comparison/booking, and is answered honestly when nothing matches', async () => {
    // A nonsense term guarantees this AND-query can never accidentally
    // match another concurrently-running test file's own temporary
    // knowledge-document fixture (Vitest runs files in parallel) -
    // exact same isolation principle as the "unknown knowledge" test in
    // answer-question.test.ts.
    const result = await routeMessage(pool, noopLlm(), {
      message: 'What is the xyzzyqux789nonexistent visa requirement for Delhi?',
    });
    expect(result.route).toBe('qa');
    if (result.route !== 'qa') throw new Error('unreachable');
    // noopLlm() would throw/return garbage if actually invoked - since
    // retrieval finds nothing, the LLM is correctly never called at
    // all, proving "no LLM unless useful" for this path too.
    expect(result.answer).toMatch(/don't have any information on file/);
  });
});
