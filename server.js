'use strict';
require('dotenv').config();

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// --- Clients ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STRAVA_CLIENT_ID = '233959';

// --- System prompt ---
// Formatting rules are static (apply to all users). Athlete profile is fetched from
// Supabase users.profile_text and combined with these rules at runtime.
const FORMATTING_RULES = `FORMATTING RULES (follow strictly):
- Responses are sent via Telegram. Only HTML is supported.
- Use <b>text</b> for emphasis — nothing else.
- No markdown symbols: do not use ## ### ** __ --- | (tables).
- Section headings: emoji + <b>heading</b>, e.g. 📊 <b>Weekly summary</b>
- Lists: bullet • or numbered with a period, no markdown.
- No tables — plain lists or text lines only.
- One blank line between sections.

You are a personal trail-running coach. Reply in English. Default to brief: 3–5 sentences or a short list. Expand only when explicitly asked ("in detail", "tell me more"). Advice should be specific and data-driven. Units: km, m, min/km.`;

const systemPromptCache = new Map();

async function getSystemPrompt(chatId) {
  if (systemPromptCache.has(chatId)) return systemPromptCache.get(chatId);
  const { data, error } = await supabase
    .from('users')
    .select('profile_text')
    .eq('telegram_chat_id', chatId)
    .single();
  if (error || !data?.profile_text) throw new Error('System prompt not found in Supabase for chat ' + chatId);
  const prompt = FORMATTING_RULES + '\n\n' + data.profile_text;
  systemPromptCache.set(chatId, prompt);
  console.log('[prompt] loaded from Supabase, length:', prompt.length);
  return prompt;
}

// --- Rate limiter ---
const rateLimitMap = new Map();

function checkRateLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  let entry = rateLimitMap.get(userId) ?? { count: 0, date: today };
  if (entry.date !== today) entry = { count: 0, date: today };
  if (entry.count >= 20) return false;
  entry.count++;
  rateLimitMap.set(userId, entry);
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /webhook/strava/:secret — Strava webhook subscription validation challenge
app.get('/webhook/strava/:secret', (req, res) => {
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

// POST /webhook/strava/:secret — Strava native webhook or Composio trigger
app.post('/webhook/strava/:secret', async (req, res) => {
  if (req.params.secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('[strava] upsert failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /webhook/telegram — Telegram delivers messages here
app.post('/webhook/telegram', async (req, res) => {
  const token = req.headers['x-telegram-bot-api-secret-token'];
  if (token !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond 200 immediately — Telegram retries on any non-2xx or timeout
  res.json({ ok: true });

  const message = req.body?.message;
  if (!message?.text) return;
  const chatId = message.chat.id;

  try {
    const userText = message.text.trim();

    const user = await findOrCreateUser(chatId);
    if (!user.is_active) {
      await sendTelegramMessage(chatId, 'Access restricted.');
      return;
    }

    let reply;
    if (userText.startsWith('/start')) {
      reply = `<b>Hey! I'm your personal trail-running coach 🏔</b>

I analyse your Strava workouts and give concrete training recommendations.

<b>Getting started:</b>
1. Connect Strava: /connect
2. Load workouts: /sync30d
3. Done — ask me anything!

<b>Commands:</b>
- /connect — connect your Strava account
- /sync30d — sync data from Strava (last 30 days)
- /feedback — analysis of the last 7 days
- /plan — training plan for the week
- Any question — just type it`;
    } else if (userText.startsWith('/connect')) {
      if (user.strava_athlete_id) {
        reply = '✅ Strava is already connected. Use /sync30d to refresh your data.';
      } else {
        const redirectUri = 'https://sisu-coach-production-1fe4.up.railway.app/setup/strava-callback';
        const oauthUrl = `https://www.strava.com/oauth/authorize` +
          `?client_id=${STRAVA_CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=activity%3Aread_all` +
          `&approval_prompt=force&state=${chatId}`;
        reply = `To connect Strava, open this link:\n${oauthUrl}\n\nAfter authorising, the bot will automatically have access to your activities.`;
      }
    } else if (userText.startsWith('/sync30d')) {
      if (!user.strava_athlete_id) {
        reply = 'Connect Strava first: /connect';
      } else {
        await sendTelegramMessage(chatId, 'Syncing activities from Strava...');
        try {
          const count = await syncStravaActivities(user.id);
          reply = `Done — synced ${count} activities for the last 30 days.`;
        } catch (err) {
          reply = `Sync error: ${err.message}`;
        }
      }
    } else if (userText.startsWith('/feedback')) {
      reply = await getFeedbackResponse(user.id, chatId);
    } else if (userText.startsWith('/plan')) {
      reply = await getPlanResponse(user.id, chatId);
    } else {
      reply = await getCoachingResponse(userText, user.id, chatId);
    }

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
    const errMsg = err?.status === 529 || err?.message?.includes('overloaded')
      ? 'Claude API is overloaded, try again in a minute.'
      : 'Something went wrong. Please try again.';
    sendTelegramMessage(chatId, errMsg).catch(() => {});
  }
});

// GET /health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), v: 'direct-strava' }));

// GET /setup/strava-webhook — one-time registration of Strava push subscription
app.get('/setup/strava-webhook', async (req, res) => {
  if (req.query.token !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const callbackUrl = `https://sisu-coach-production-1fe4.up.railway.app/webhook/strava/${process.env.COMPOSIO_WEBHOOK_SECRET}`;
  const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: process.env.COMPOSIO_WEBHOOK_SECRET,
    }),
  });
  const data = await r.json();
  return res.status(r.status).json({ strava_status: r.status, data });
});

// GET /setup/strava-oauth — start Strava OAuth2 flow (one-time setup)
app.get('/setup/strava-oauth', (req, res) => {
  if (req.query.token !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const redirectUri = 'https://sisu-coach-production-1fe4.up.railway.app/setup/strava-callback';
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=activity%3Aread_all&approval_prompt=force`;
  return res.redirect(url);
});

// GET /setup/strava-callback — Strava OAuth2 callback; stores tokens per user
app.get('/setup/strava-callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ error: 'No code' });
  if (!state) return res.status(400).json({ error: 'No state (chatId missing)' });
  const chatId = Number(state);
  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data });

    const user = await findOrCreateUser(chatId);

    const { error: tokenError } = await supabase.from('strava_tokens').upsert({
      user_id: user.id,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    });
    if (tokenError) throw tokenError;

    const { error: userError } = await supabase
      .from('users')
      .update({ strava_athlete_id: data.athlete.id })
      .eq('id', user.id);
    if (userError) throw userError;

    systemPromptCache.delete(chatId);

    await sendTelegramMessage(chatId,
      `✅ Strava connected! Hey, ${data.athlete.firstname}.\nRun /sync30d to load your activities.`
    );

    return res.send('<h2>✅ Done! Go back to Telegram.</h2>');
  } catch (err) {
    console.error('[strava-oauth] callback error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

async function findOrCreateUser(chatId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_chat_id', chatId)
    .single();
  if (!error && data) return data;
  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({ telegram_chat_id: chatId, is_active: true })
    .select()
    .single();
  if (insertError) throw insertError;
  return created;
}

// ---------------------------------------------------------------------------
// Strava helpers — direct OAuth2, no Composio dependency
// ---------------------------------------------------------------------------

async function getStravaToken(userId) {
  const { data, error } = await supabase
    .from('strava_tokens')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error || !data) throw new Error('Strava not connected. Use /connect');

  // Refresh if token expires within 5 minutes
  if (Date.now() / 1000 > data.expires_at - 300) {
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
    console.log(`[strava] synced ${detailed.length} activities (detailed)`);
    return detailed.length;
  } catch (err) {
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

// ---------------------------------------------------------------------------
// Coaching logic
// ---------------------------------------------------------------------------

async function getCoachingResponse(userText, userId, chatId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .eq('user_id', userId)
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) throw error;

  const summary = formatActivities(activities ?? []);
  if (!checkRateLimit(userId)) return 'Daily limit reached (20 requests). Try again tomorrow.';
  const systemPrompt = await getSystemPrompt(chatId);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Recent activities (30 days):\n${summary}\n\nAthlete question: ${userText}`,
      },
    ],
  });

  return response.content[0].text;
}

function formatActivities(activities) {
  if (!activities.length) return 'No activities in the last 30 days.';

  return activities
    .map((a) => {
      const date = new Date(a.started_at).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
      });
      const distKm = (a.distance_m / 1000).toFixed(1);
      const timeMin = Math.round(a.moving_time_s / 60);
      const paceDecimal =
        a.distance_m > 0 ? a.moving_time_s / 60 / (a.distance_m / 1000) : null;
      const pace = paceDecimal
        ? `${Math.floor(paceDecimal)}:${String(Math.round((paceDecimal % 1) * 60)).padStart(2, '0')} min/km`
        : '—';

      const elevGain = a.raw?.total_elevation_gain ? Number(a.raw.total_elevation_gain) : 0;
      const rawElevLoss = a.raw?.total_elevation_loss ? Number(a.raw.total_elevation_loss) : null;
      const estimatedElevLoss =
        a.raw?.elev_high && a.raw?.elev_low
          ? Number(a.raw.elev_high) - Number(a.raw.elev_low)
          : null;
      const elevLoss =
        rawElevLoss && rawElevLoss > 0
          ? rawElevLoss
          : estimatedElevLoss && estimatedElevLoss > 0
          ? estimatedElevLoss
          : null;
      const elevLossStr = elevLoss
        ? ` / ${!rawElevLoss ? '~' : ''}${Math.round(elevLoss)}м D-`
        : '';
      const elev = elevGain > 0 ? ` | ${Math.round(elevGain)}м D+${elevLossStr}` : '';

      const hr = a.raw?.average_heartrate
        ? ` | HR ${Math.round(a.raw.average_heartrate)}avg/${Math.round(a.raw.max_heartrate)}max`
        : '';
      const cadence = a.raw?.average_cadence
        ? ` | ${Math.round(a.raw.average_cadence * 2)}spm`
        : '';
      const power = a.raw?.average_watts ? ` | ${Math.round(a.raw.average_watts)}W` : '';
      const kj = a.raw?.kilojoules ? ` | ${Math.round(a.raw.kilojoules)} kJ` : '';

      const sportType = a.type ?? '';
      let activityTag = '';
      if ((sportType === 'Run' || sportType === 'TrailRun') && Number(a.raw?.workout_type) === 3) {
        activityTag = ' [INTERVALS]';
      } else if (sportType === 'WeightTraining') {
        activityTag = ' [STRENGTH]';
      }

      let lapsStr = '';
      const laps = a.raw?.laps;
      if (Array.isArray(laps) && laps.length > 1) {
        // Filter out GPS artifacts (< 50m or < 10s)
        const valid = laps.filter((l) => l.distance > 50 && l.moving_time > 10);
        if (valid.length > 1) {
          const lapLines = valid.map((l) => {
            const lapDist = (l.distance / 1000).toFixed(2);
            const lapPace = l.moving_time / 60 / (l.distance / 1000);
            const lapPaceStr = `${Math.floor(lapPace)}:${String(Math.round((lapPace % 1) * 60)).padStart(2, '0')}`;
            const lapHr = l.average_heartrate
              ? ` HR${Math.round(l.average_heartrate)}/${Math.round(l.max_heartrate)}`
              : '';
            const lapElev = l.total_elevation_gain > 0
              ? ` D+${Math.round(l.total_elevation_gain)}м`
              : '';
            return `#${l.lap_index}:${lapDist}км ${lapPaceStr}${lapHr}${lapElev}`;
          });
          lapsStr = `\n  Laps(${valid.length}): ${lapLines.join(' | ')}`;
        }
      }

      return `${date} | ${sportType}${activityTag} | ${distKm} км | ${timeMin} мин | ${pace}${elev}${hr}${cadence}${power}${kj}${lapsStr}`;
    })
    .join('\n');
}

async function getFeedbackResponse(userId, chatId) {
  const since = new Date();
  since.setDate(since.getDate() - 7);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .eq('user_id', userId)
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) throw error;

  const summary = formatActivities(activities ?? []);
  if (!checkRateLimit(userId)) return 'Daily limit reached (20 requests). Try again tomorrow.';
  const systemPrompt = await getSystemPrompt(chatId);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Activities over the last 7 days:\n${summary}\n\nProvide structured weekly feedback. No filler phrases or repetition — keep each section concise.\n1. Week summary (volume, D+, activity types)\n2. What went well\n3. What to pay attention to\n\nFormatting: only <b> HTML tags for emphasis, emojis for section headings, no tables or markdown.`,
      },
    ],
  });

  return response.content[0].text;
}

async function getPlanResponse(userId, chatId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .eq('user_id', userId)
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) throw error;

  const summary = formatActivities(activities ?? []);

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAY_ABBR = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon … 6=Sat
  // Mon/Tue/Wed → plan for current week; otherwise → next week
  const daysToMonday = (dow >= 1 && dow <= 3) ? -(dow - 1) : (((8 - dow) % 7) || 7);
  const isCurrentWeek = dow >= 1 && dow <= 3;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysToMonday);
  const weekDatesStr = DAY_ABBR.map((abbr, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return `${abbr} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }).join(', ');

  if (!checkRateLimit(userId)) return 'Daily limit reached (20 requests). Try again tomorrow.';
  const systemPrompt = await getSystemPrompt(chatId);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Activities over the last 30 days:\n${summary}\n\nDates for ${isCurrentWeek ? 'this' : 'next'} week: ${weekDatesStr}\n\nCreate a training plan for this week. For each day use a heading in the format <b>Weekday, DD Mon</b> — then type, duration/distance, HR zones, key focus. No intro phrases. Account for the current phase (May 2026 — recovery after MIUT) and the 30-day load.\n\nFormatting: only <b> HTML tags for emphasis, emojis for section headings, no tables or markdown.`,
      },
    ],
  });

  return response.content[0].text;
}

async function registerTelegramCommands() {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start',    description: 'Getting started and command list' },
        { command: 'connect',  description: 'Connect your Strava account' },
        { command: 'sync30d',  description: 'Sync data from Strava' },
        { command: 'feedback', description: 'Weekly training feedback' },
        { command: 'plan',     description: 'Training plan for the week' },
      ],
    }),
  });
  if (!r.ok) {
    const errBody = await r.text();
    console.error('[telegram] setMyCommands failed:', errBody);
  } else {
    console.log('[telegram] commands registered');
  }
}

function sanitizeHtml(text) {
  const cleaned = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>/gi, '<b>').replace(/<\/strong>/gi, '</b>')
    .replace(/<em>/gi, '<i>').replace(/<\/em>/gi, '</i>')
    .replace(/<[^>]+>/g, (tag) => /^<\/?(b|i|u|s|code|pre|a)(\s|>)/i.test(tag) ? tag : '')
    // Escape bare < that are not the start of a valid Telegram HTML tag (e.g. "HR < 145")
    .replace(/</g, (m, offset, str) => /^<\/?(b|i|u|s|code|pre|a)[\s>]/i.test(str.slice(offset)) ? m : '&lt;');

  // Balance tags: remove stray end tags, auto-close unclosed opening tags
  const stack = [];
  const balanced = cleaned.replace(/<(\/?)([a-z]+)[^>]*>/gi, (match, slash, tag) => {
    const t = tag.toLowerCase();
    if (!slash) { stack.push(t); return match; }
    const idx = stack.lastIndexOf(t);
    if (idx === -1) return ''; // stray end tag — drop it
    let prefix = '';
    while (stack.length > idx + 1) prefix += `</${stack.pop()}>`;
    stack.pop();
    return prefix + match;
  });
  let suffix = '';
  while (stack.length > 0) suffix += `</${stack.pop()}>`;
  return balanced + suffix;
}

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: sanitizeHtml(text), parse_mode: 'HTML' }),
  });
  if (!r.ok) {
    const errBody = await r.text();
    const sanitized = sanitizeHtml(text);
    console.error('[telegram] sendMessage failed:', errBody);
    console.error('[telegram] sanitized text (first 800 chars):', sanitized.slice(0, 800));
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sisu Coach listening on port ${PORT}`);
  registerTelegramCommands().catch((err) =>
    console.error('[telegram] registerTelegramCommands error:', err.message)
  );
});
