import type { Pool } from 'pg';
import { DESTINATIONS, type Destination } from '../destinations';
import { buildCandidateSet } from '../travel-intelligence/candidate-set';
import { recommendFood } from '../food/recommend-food';
import { haversineDistanceKm } from '../geo';
import { retrieveKnowledge } from '../knowledge/retrieve-knowledge';
import { narrateKnowledge } from '../ai/knowledge-narration';
import type { LlmProvider } from '../ai/llm-provider';

export interface QuestionAnswer {
  text: string;
  /** Which known destination (if any) the answer is actually grounded in - for tests/observability, not shown to the user. */
  matchedDestinationSlug: string | null;
}

const DISTANCE_QUESTION = /how far is (.+?) from (.+?)\??$/i;

function findMentionedDestination(message: string): Destination | null {
  const lower = message.toLowerCase();
  for (const destination of Object.values(DESTINATIONS)) {
    if (lower.includes(destination.name.toLowerCase()) || lower.includes(destination.slug)) {
      return destination;
    }
  }
  return null;
}

interface PlaceLocation {
  name: string;
  latitude: number;
  longitude: number;
}

async function findPlaceByName(pool: Pool, name: string): Promise<PlaceLocation | null> {
  const result = await pool.query(
    `select name, ST_Y(location::geometry) as latitude, ST_X(location::geometry) as longitude
     from places where lower(name) = lower($1) limit 1`,
    [name],
  );
  if (result.rows.length === 0) return null;
  return {
    name: result.rows[0].name,
    latitude: Number(result.rows[0].latitude),
    longitude: Number(result.rows[0].longitude),
  };
}

async function answerDistanceQuestion(pool: Pool, nameA: string, nameB: string): Promise<QuestionAnswer> {
  const [placeA, placeB] = await Promise.all([findPlaceByName(pool, nameA), findPlaceByName(pool, nameB)]);

  if (!placeA || !placeB) {
    const missing = [!placeA ? nameA : null, !placeB ? nameB : null].filter(Boolean).join(' and ');
    return {
      text: `I don't have location data for ${missing}, so I can't calculate that distance.`,
      matchedDestinationSlug: null,
    };
  }

  const km = haversineDistanceKm(placeA, placeB);
  return {
    text: `${placeA.name} is about ${km.toFixed(1)} km from ${placeB.name}.`,
    matchedDestinationSlug: null,
  };
}

const KNOWLEDGE_QUESTION = /\b(visa|advisory|advisories|safety|requirement|entry requirement)\b/i;

/**
 * The Phase 2 Q&A capability (plan §N Phase 2 / CLAUDE.md §5.3): answers
 * a small question using only existing deterministic Travel Intelligence
 * reads, or (Phase 6) deterministic knowledge retrieval - grounded
 * synthesis is the only path here that ever calls an LLM, and even then
 * only when relevant documents were actually retrieved. Never creates an
 * itinerary or a task. When the question is about a destination/place
 * this system has no data for, it says so honestly instead of guessing
 * (plan §16 trust boundary).
 */
export async function answerQuestion(pool: Pool, llmProvider: LlmProvider, message: string): Promise<QuestionAnswer> {
  const distanceMatch = message.match(DISTANCE_QUESTION);
  if (distanceMatch) {
    return answerDistanceQuestion(pool, distanceMatch[1].trim(), distanceMatch[2].trim());
  }

  const destination = findMentionedDestination(message);
  if (!destination) {
    const known = Object.values(DESTINATIONS).map((d) => d.name).join(', ');
    return {
      text: `I don't have information about that destination yet - I can currently help with ${known}.`,
      matchedDestinationSlug: null,
    };
  }

  const lower = message.toLowerCase();

  // RAG path (V2 architecture Phase 6 §3/§G): deterministic keyword
  // dispatch, same tier as the existing "eat/food/restaurant" check
  // below - no LLM intent classification, and the LLM is only ever
  // invoked over documents already retrieved deterministically.
  if (KNOWLEDGE_QUESTION.test(message)) {
    const documents = await retrieveKnowledge(pool, message, { destinationSlug: destination.slug });
    if (documents.length === 0) {
      return {
        text: `I don't have any information on file about that for ${destination.name}.`,
        matchedDestinationSlug: destination.slug,
      };
    }
    const { answer } = await narrateKnowledge(llmProvider, documents, message);
    return { text: answer, matchedDestinationSlug: destination.slug };
  }

  if (lower.includes('eat') || lower.includes('food') || lower.includes('restaurant')) {
    const recommendations = await recommendFood(pool, destination.slug, destination.center);
    if (recommendations.length === 0) {
      return {
        text: `I don't have any restaurant recommendations on file for ${destination.name} yet.`,
        matchedDestinationSlug: destination.slug,
      };
    }
    const names = recommendations.slice(0, 5).map((r) => r.name).join(', ');
    return {
      text: `A few options in ${destination.name}: ${names}.`,
      matchedDestinationSlug: destination.slug,
    };
  }

  // Generic destination overview - grounded in exactly what's on file, nothing invented.
  const candidateSet = await buildCandidateSet(pool, destination.slug, destination.center);
  const warningNote = candidateSet.warnings.length > 0 ? `, plus ${candidateSet.warnings.length} travel note(s)` : '';
  return {
    text: `${destination.name} has ${candidateSet.attractions.length} attraction(s), ${candidateSet.restaurants.length} restaurant(s) and ${candidateSet.shops.length} shop(s) on file${warningNote}.`,
    matchedDestinationSlug: destination.slug,
  };
}
