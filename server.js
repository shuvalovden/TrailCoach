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

// Lazy-load ESM @composio/core via dynamic import (CJS compat)
let _composio;
async function getComposio() {
  if (!_composio) {
    const { Composio } = await import('@composio/core');
    _composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  }
  return _composio;
}

// --- System prompt ---
const SYSTEM_PROMPT = `Ты персональный тренер по трейловому бегу. Отвечай всегда на русском языке.
Давай конкретные, персонализированные советы на основе последних тренировок атлета. Будь прямым и специфичным. Используй метрические единицы (км, м, мин/км).

ПРОФИЛЬ АТЛЕТА:
- Опытный любитель, живёт в Италия в Трентино
- Специализация: трейловый бег, вертикальные километры (VK)
- Недавний результат: MIUT Marathon 40K за 5:40 (25 апреля 2026) — лучше прогноза
- Типичный объём бега: 30–40 км/нед, часто меньше
- Кросс-тренинг: скитур (зима), велосипед, хайкинг — сильная аэробная база

ПУЛЬСОВЫЕ ЗОНЫ:
- Z1: до 131 уд/мин
- Z2: 131–145 уд/мин
- Z3: 146–164 уд/мин
- Z4: 165–175 уд/мин
- Z5: 175+ уд/мин

СИЛЬНЫЕ СТОРОНЫ:
- Хорошая аэробная база (скитур = фактически hill repeats всю зиму)
- Умеет контролировать пульс и слушать тело
- Power hiking на подъёмах при HR 162+ работает отлично
- Хорошая генетическая аэробная адаптивность

СЛАБЫЕ МЕСТА И ЗОНЫ РИСКА:
- Спуски: квадрицепсы забиваются на длинных сбросах высоты (−1000м+)
- IT-тракт правого колена — зона риска, требует профилактики (ролл + боковые упражнения)
- Исторически мало силовых тренировок
- Лёгкий бег исторически слишком быстрый — нужно держать HR < 145 (~7:15–7:30 мин/км)
- Длинные выходы 25–28 км ещё не освоены (максимум этого сезона 17 км)

ТЕКУЩИЙ ПЛАН (май–октябрь 2026):
- Май: восстановление после MIUT. Ролл ежедневно.
- Июнь: База 1 — объём Z1–Z2, силовая 2x/нед, первые тренировки на спусках
- Июль: База 2 + VK специфика — hill repeats 3–4 мин в Z4, подъёмы 40–55 мин Z3
- 1 августа: PizTri Vertical (Malonno) — 3.52 km / 1000D+, цель sub-60 мин
- Август: База 3 — акцент на спуски (8 недель осознанной работы)
- Сентябрь–октябрь: Специфика трейл, осенняя гонка 25–30 km / 2000D+

КЛЮЧЕВЫЕ ПРИНЦИПЫ:
- Лёгкий бег реально лёгкий: HR < 145, темп ~7:15–7:30 мин/км
- Power hiking при HR 162+ на подъёмах — не бороться с горой
- Тейпер при объёме 30–40 км/нед = снижение на 30%, не на 50%
- Тренировать кишечник питанием на каждой длинной тренировке
- Силовая даёт эффект через 7–10 дней — планировать с учётом этого
- 6–8 повторов крутого спуска раз в неделю = ключ к развитию квадрицепсов

Когда анализируешь тренировки — обращай внимание на:
1. Соответствие пульса зонам (не слишком ли быстро на лёгких?)
2. Наличие работы на спусках
3. Регулярность силовых
4. Накопленный D+ за неделю (не только км)
5. Признаки недовосстановления`;

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

    if (body?.object_type === 'activity' && body?.aspect_type === 'create') {
      // Strava native format — only has object_id; fetch full details via Composio
      strava_id = Number(body.object_id);
      activityData = await fetchStravaActivity(strava_id);
    } else {
      // Composio v3: { type, metadata, data }  |  v2: { triggerData } or { payload }
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

  try {
    const message = req.body?.message;
    if (!message?.text) return;

    const chatId = message.chat.id;
    const userText = message.text;

    const reply = await getCoachingResponse(userText);
    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
  }
});

// GET /health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), v: '76e1a38' }));

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
      client_id: '233959',
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: process.env.COMPOSIO_WEBHOOK_SECRET,
    }),
  });
  const data = await r.json();
  return res.status(r.status).json({ strava_status: r.status, data });
});

// ---------------------------------------------------------------------------
// Strava helpers
// ---------------------------------------------------------------------------

async function composioExecute(action, input) {
  const r = await fetch(`https://backend.composio.dev/api/v2/actions/${action}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.COMPOSIO_API_KEY,
    },
    body: JSON.stringify({ connectedAccountId: 'strava_melano-rusher', input }),
  });
  if (!r.ok) throw new Error(`Composio HTTP ${r.status}`);
  const json = await r.json();
  // v2 wraps result in json.data, which may contain the array or a nested object
  return json?.data ?? json;
}

async function syncStravaActivities() {
  try {
    const since = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
    let activities = await composioExecute('STRAVA_LIST_ATHLETE_ACTIVITIES', { after: since, per_page: 30 });

    if (typeof activities === 'string') {
      try { activities = JSON.parse(activities); } catch { activities = []; }
    }
    if (!Array.isArray(activities)) activities = activities?.details ?? activities?.data ?? activities?.activities ?? [];
    if (!Array.isArray(activities)) {
      console.warn('[strava] unexpected sync response format');
      return;
    }

    const upserts = activities.map((a) =>
      supabase.from('activities').upsert(
        {
          strava_id: a.id,
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
    console.log(`[strava] synced ${activities.length} activities`);
  } catch (err) {
    console.error('[strava] sync error:', err.message);
  }
}

async function fetchStravaActivity(activityId) {
  try {
    const result = await composioExecute('STRAVA_GET_ACTIVITY', { id: String(activityId) });
    return typeof result === 'string' ? JSON.parse(result) : result;
  } catch (err) {
    console.error('[strava] fetchActivity error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Coaching logic
// ---------------------------------------------------------------------------

async function getCoachingResponse(userText) {
  // Pull fresh data from Strava before responding (fire-and-forget pattern with await
  // so Claude sees the latest activities; tolerate failures gracefully)
  await syncStravaActivities();

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) throw error;

  const summary = formatActivities(activities ?? []);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Последние тренировки (30 дней):\n${summary}\n\nВопрос атлета: ${userText}`,
      },
    ],
  });

  return response.content[0].text;
}

function formatActivities(activities) {
  if (!activities.length) return 'Нет тренировок за последние 30 дней.';

  return activities
    .map((a) => {
      const date = new Date(a.started_at).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
      });
      const distKm = (a.distance_m / 1000).toFixed(1);
      const timeMin = Math.round(a.moving_time_s / 60);
      const paceDecimal =
        a.distance_m > 0 ? a.moving_time_s / 60 / (a.distance_m / 1000) : null;
      const pace = paceDecimal
        ? `${Math.floor(paceDecimal)}:${String(Math.round((paceDecimal % 1) * 60)).padStart(2, '0')} мин/км`
        : '—';
      const elev = a.raw?.total_elevation_gain
        ? ` | ${Math.round(a.raw.total_elevation_gain)}м D+`
        : '';
      const hr = a.raw?.average_heartrate
        ? ` | HR ${Math.round(a.raw.average_heartrate)}avg/${Math.round(a.raw.max_heartrate)}max`
        : '';
      return `${date} | ${a.type} | ${distKm} км | ${timeMin} мин | ${pace}${elev}${hr}`;
    })
    .join('\n');
}

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!r.ok) {
    const errBody = await r.text();
    console.error('[telegram] sendMessage failed:', errBody);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sisu Coach listening on port ${PORT}`));
