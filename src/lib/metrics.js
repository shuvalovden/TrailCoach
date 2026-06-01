'use strict';
const { supabase } = require('./clients');

// --- Metrics (in-memory, reset on restart) ---
const metrics = {
  telegram: {
    messages_total: 0,
    messages_by_command: { start: 0, connect: 0, sync30d: 0, feedback: 0, plan: 0, freetext: 0 },
    send_failures: 0,
  },
  claude: {
    calls_total: 0,
    errors_total: 0,
    tokens_input: 0,
    tokens_output: 0,
    latency_ms_last: 0,
    latency_last10: [],
  },
  strava: {
    syncs_total: 0,
    sync_errors: 0,
    webhook_events: 0,
    token_refreshes: 0,
    sync_latency_ms_last: 0,
  },
  supabase: { errors_total: 0 },
  ratelimit: { hits_total: 0 },
};

function calcPercentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1)];
}

// metrics_daily schema (run once in Supabase SQL editor):
// CREATE TABLE IF NOT EXISTS metrics_daily (
//   date               date PRIMARY KEY,
//   telegram_messages  int DEFAULT 0,
//   claude_calls       int DEFAULT 0,
//   claude_errors      int DEFAULT 0,
//   tokens_input       bigint DEFAULT 0,
//   tokens_output      bigint DEFAULT 0,
//   strava_syncs       int DEFAULT 0,
//   strava_sync_errors int DEFAULT 0,
//   strava_webhooks    int DEFAULT 0,
//   supabase_errors    int DEFAULT 0,
//   ratelimit_hits     int DEFAULT 0,
//   updated_at         timestamptz DEFAULT now()
// );
async function flushMetrics() {
  const date = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('metrics_daily').upsert(
    {
      date,
      telegram_messages:  metrics.telegram.messages_total,
      claude_calls:       metrics.claude.calls_total,
      claude_errors:      metrics.claude.errors_total,
      tokens_input:       metrics.claude.tokens_input,
      tokens_output:      metrics.claude.tokens_output,
      strava_syncs:       metrics.strava.syncs_total,
      strava_sync_errors: metrics.strava.sync_errors,
      strava_webhooks:    metrics.strava.webhook_events,
      supabase_errors:    metrics.supabase.errors_total,
      ratelimit_hits:     metrics.ratelimit.hits_total,
      updated_at:         new Date().toISOString(),
    },
    { onConflict: 'date' }
  );
  if (error) {
    console.error('[metrics] flush failed:', error.message);
  } else {
    console.log('[metrics] flushed to Supabase for', date);
  }
}

module.exports = { metrics, calcPercentile, flushMetrics };
