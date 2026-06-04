'use strict';
require('dotenv').config();

const express = require('express');
const { metrics, calcPercentile, flushMetrics } = require('./lib/metrics');
const { registerTelegramCommands } = require('./lib/telegram');
const telegramRouter = require('./routes/telegram');
const stravaRouter = require('./routes/strava');
const setupRouter = require('./routes/setup');

const app = express();
app.use(express.json());

app.use(telegramRouter);
app.use(stravaRouter);
app.use(setupRouter);

app.get('/health', (_req, res) => {
  const lat = metrics.claude.latency_last10;
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    v: 'direct-strava',
    uptime_s: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    metrics: {
      telegram: {
        messages_total: metrics.telegram.messages_total,
        messages_by_command: metrics.telegram.messages_by_command,
        send_failures: metrics.telegram.send_failures,
      },
      claude: {
        calls_total: metrics.claude.calls_total,
        errors_total: metrics.claude.errors_total,
        tokens_input: metrics.claude.tokens_input,
        tokens_output: metrics.claude.tokens_output,
        latency_p50_ms: calcPercentile(lat, 50),
        latency_p90_ms: calcPercentile(lat, 90),
      },
      strava: {
        syncs_total: metrics.strava.syncs_total,
        sync_errors: metrics.strava.sync_errors,
        webhook_events: metrics.strava.webhook_events,
        token_refreshes: metrics.strava.token_refreshes,
      },
      supabase: { errors_total: metrics.supabase.errors_total },
      ratelimit: { hits_total: metrics.ratelimit.hits_total },
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sisu Coach listening on port ${PORT}`);
  registerTelegramCommands().catch((err) =>
    console.error('[telegram] registerTelegramCommands error:', err.message)
  );
  setTimeout(flushMetrics, 10 * 1000);            // initial flush 10s after startup
  setInterval(flushMetrics, 3 * 60 * 60 * 1000); // every 3 hours

  process.on('SIGTERM', async () => {
    console.log('[metrics] SIGTERM received — flushing metrics before shutdown');
    await flushMetrics();
    process.exit(0);
  });
});
