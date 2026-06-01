'use strict';
const { Router } = require('express');
const { supabase } = require('../lib/clients');
const { fetchStravaActivity } = require('../services/strava');
const { metrics } = require('../lib/metrics');
const { alertAdmin } = require('../lib/telegram');

const router = Router();

// GET /webhook/strava/:secret — Strava webhook subscription validation challenge
router.get('/webhook/strava/:secret', (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken === process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.json({ 'hub.challenge': challenge });
  }
  return res.status(403).json({ error: 'Verification failed' });
});

// POST /webhook/strava/:secret — Strava native webhook
router.post('/webhook/strava/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  metrics.strava.webhook_events++;

  try {
    const body = req.body;
    let activityData;
    let strava_id;
    let webhookUserId = null;

    if (body?.object_type === 'activity' && body?.aspect_type === 'create') {
      // Strava native format — route to the correct user by owner_id
      strava_id = Number(body.object_id);
      const ownerId = Number(body.owner_id);
      const { data: webhookUser } = await supabase
        .from('users')
        .select('id')
        .eq('strava_athlete_id', ownerId)
        .single();
      if (!webhookUser) {
        console.log(`[strava] webhook: no user for strava_athlete_id=${ownerId}, ignoring`);
        return res.json({ ok: true });
      }
      webhookUserId = webhookUser.id;
      activityData = await fetchStravaActivity(strava_id, webhookUserId);
    } else {
      activityData = body?.data ?? body?.triggerData ?? body?.payload ?? body;
      strava_id = Number(activityData?.id ?? activityData?.object_id);
    }

    if (!strava_id) {
      console.warn('[strava] missing activity id — body keys:', Object.keys(body));
      return res.status(400).json({ error: 'Missing activity id' });
    }

    const { error } = await supabase.from('activities').upsert(
      {
        strava_id,
        user_id: webhookUserId,
        type: activityData?.type ?? activityData?.sport_type ?? 'Unknown',
        distance_m: activityData?.distance ?? 0,
        moving_time_s: activityData?.moving_time ?? 0,
        started_at: activityData?.start_date ?? activityData?.start_date_local ?? new Date().toISOString(),
        raw: activityData,
      },
      { onConflict: 'strava_id' }
    );

    if (error) {
      metrics.supabase.errors_total++;
      alertAdmin(`[TrailCoach] strava webhook upsert error: ${error.message}`);
      throw error;
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[strava] upsert failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
