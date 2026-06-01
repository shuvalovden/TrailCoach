'use strict';
const { supabase, STRAVA_CLIENT_ID } = require('../lib/clients');
const { metrics } = require('../lib/metrics');
const { alertAdmin } = require('../lib/telegram');

async function getStravaToken(userId) {
  const { data, error } = await supabase
    .from('strava_tokens')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) {
    if (error) metrics.supabase.errors_total++;
    throw new Error('Strava not connected. Use /connect');
  }

  // Refresh if token expires within 5 minutes
  if (Date.now() / 1000 > data.expires_at - 300) {
    metrics.strava.token_refreshes++;
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: data.refresh_token,
      }),
    });
    if (!r.ok) throw new Error(`Strava token refresh failed: ${r.status}`);
    const refreshed = await r.json();
    await supabase.from('strava_tokens').upsert({
      user_id: userId,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    });
    return refreshed.access_token;
  }

  return data.access_token;
}

async function syncStravaActivities(userId) {
  metrics.strava.syncs_total++;
  const t0 = Date.now();
  try {
    const token = await getStravaToken(userId);
    const since = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since}&per_page=30`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Strava API ${r.status}`);
    const summaries = await r.json();

    // Fetch detailed activity data (includes laps, splits, best efforts)
    // Parallel — 30 requests is well within Strava's 200/15min rate limit
    const detailed = await Promise.all(
      summaries.map((a) => fetchStravaActivity(a.id, userId).then((d) => d ?? a))
    );

    const upserts = detailed.map((a) =>
      supabase.from('activities').upsert(
        {
          strava_id: a.id,
          user_id: userId,
          type: a.sport_type ?? a.type ?? 'Unknown',
          distance_m: a.distance ?? 0,
          moving_time_s: a.moving_time ?? 0,
          started_at: a.start_date ?? a.start_date_local ?? new Date().toISOString(),
          raw: a,
        },
        { onConflict: 'strava_id' }
      )
    );

    await Promise.all(upserts);
    const latency = Date.now() - t0;
    metrics.strava.sync_latency_ms_last = latency;
    console.log(`[strava] sync user_id=${userId} count=${detailed.length} latency_ms=${latency}`);
    return detailed.length;
  } catch (err) {
    metrics.strava.sync_errors++;
    alertAdmin(`[TrailCoach] strava sync error: ${err.message}`);
    console.error('[strava] sync error:', err.message);
    throw err;
  }
}

async function fetchStravaActivity(activityId, userId = null) {
  try {
    let token;
    if (userId) {
      token = await getStravaToken(userId);
    } else {
      // Webhook context: no userId — fall back to strava_config
      const { data } = await supabase.from('strava_config').select('access_token').eq('id', 1).single();
      if (!data?.access_token) throw new Error('No Strava token available');
      token = data.access_token;
    }
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Strava API ${r.status}`);
    return r.json();
  } catch (err) {
    console.error('[strava] fetchActivity error:', err.message);
    return null;
  }
}

module.exports = { getStravaToken, syncStravaActivities, fetchStravaActivity };
