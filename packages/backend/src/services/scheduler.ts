import { generateAlerts } from './alerts';

// How often the checks behind the Alerts page are re-run.
//
// Alerts were fully written and reachable from the UI, but nothing ever called
// them: the table stayed empty and the page reported a calm "no alerts" that
// actually meant "never looked". This is the missing call.
//
// Chosen so that the schedule is not a second place for the thresholds to
// live. The staleness a given alert describes is already configured — pending
// transfers key off `pending_transfer_alert_hours`, reconciliations off
// `reconciliation_period_days` — and those are the meaningful delays. This
// interval only decides how soon after crossing one an operator gets told, so
// it stays short and needs no setting of its own.
const ALERT_INTERVAL_MINUTES = 15;

let timer: NodeJS.Timeout | null = null;
let running = false;

// Runs one pass. Overlap is refused rather than queued: a pass that somehow
// outlives its interval should not be followed by a second, and an operator
// refreshing the page has the manual `/alerts/generate` for an immediate run.
export async function runAlertGeneration(): Promise<number | null> {
  if (running) return null;
  running = true;
  try {
    return await generateAlerts();
  } catch (error) {
    // A failed pass logs and stands down. The next interval retries — an alert
    // that cannot be generated must never take the process with it.
    console.error('Alert generation failed:', error);
    return null;
  } finally {
    running = false;
  }
}

export function startAlertScheduler(): void {
  if (timer) return;

  // One pass shortly after boot rather than immediately: the process has only
  // just connected, and a restart should not make an operator wait a full
  // interval to be told about something that changed while it was down.
  const initial = setTimeout(() => { void runAlertGeneration(); }, 10_000);
  timer = setInterval(() => { void runAlertGeneration(); }, ALERT_INTERVAL_MINUTES * 60_000);

  // A timer must not be the reason the process refuses to exit.
  initial.unref?.();
  timer.unref?.();

  console.log(`Alert scheduler running every ${ALERT_INTERVAL_MINUTES} minutes`);
}

export function stopAlertScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
