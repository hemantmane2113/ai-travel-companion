import 'dotenv/config';
import { Pool } from 'pg';
import { SandboxWriteProvider } from '../providers/sandbox-write-provider';
import { runReconciliation, type ReconciliationItemResult } from './reconciliation';

/**
 * Manual reconciliation command (V2 architecture Phase 10) - mirrors
 * seed:warnings/seed:knowledge/ingest:places exactly: a plain CLI
 * script, never a scheduler/worker/HTTP endpoint. Constructs the
 * dependencies, invokes the reconciliation function, prints a concise
 * result, exits cleanly - all real logic lives in reconciliation.ts.
 *
 * Uses the same SandboxWriteProvider the running app's CoreModule
 * registers by default. Its idempotency cache is in-memory and
 * per-instance, so a CLI run in a separate process from the live server
 * can only ever observe confirmations it itself created - for a stale
 * record left by a genuinely different (e.g. crashed) process, it will
 * correctly and safely report 'not_executed'/ambiguous rather than
 * fabricate a recovery it cannot actually verify. This is an inherent,
 * intentional property of a deliberately non-persistent sandbox
 * provider, not a bug to work around in this phase.
 *
 * Usage: npm run reconcile:jobs
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const writeProvider = new SandboxWriteProvider();
    const report = await runReconciliation(pool, writeProvider);

    console.log(`Reconciliation complete (staleness threshold: ${report.staleMinutes} minute(s)).`);

    const groups: Array<[string, ReconciliationItemResult[]]> = [
      ['itinerary jobs', report.itineraryJobs],
      ['tasks', report.tasks],
      ['bookings (executing)', report.bookingsExecuting],
      ['bookings (cancelling)', report.bookingsCancelling],
      ['rebookings', report.rebookings],
    ];

    let totalFound = 0;
    for (const [label, items] of groups) {
      if (items.length === 0) continue;
      totalFound += items.length;
      console.log(`\n${label}:`);
      for (const item of items) {
        console.log(`  - ${item.id}: ${item.action}${item.detail ? ` (${item.detail})` : ''}`);
      }
    }

    if (totalFound === 0) {
      console.log('No stale records found.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
