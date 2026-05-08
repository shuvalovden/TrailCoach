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
const SYSTEM_PROMPT = `ПРАВИЛА ФОРМАТИРОВАНИЯ (строго соблюдать):
- Ответ отправляется в Telegram. Поддерживается только HTML.
- Для выделения использовать <b>текст</b> — и ничего другого.
- Никаких markdown-символов: не использовать ## ### ** __ --- | (таблицы).
- Разделы обозначать эмодзи + <b>заголовок</b>, например: 📊 <b>Итоги</b>
- Списки оформлять через • (буллет) или цифры с точкой, без markdown.
- Никаких таблиц — только простые списки или строки текста.
- Между разделами — одна пустая строка.

Ты персональный тренер по трейловому бегу. Отвечай всегда на русском языке.
По умолчанию отвечай кратко: 3–5 предложений или короткий список без воды.
Если атлет явно просит подробности (слова «подробно», «детально», «расскажи больше», «объясни») — тогда можно развернуть ответ.
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
5. Признаки недовосстановления
6. Типы активностей в данных: Run/TrailRun — бег, WeightTraining — силовая, Workout — общая тренировка (может быть что угодно: кросс-тренинг, ОФП, мобилити — но НЕ обязательно силовая). Не путать Workout и WeightTraining.`;

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
      // Strava native format — only has object_id; fetch full details from Strava API
      strava_id = Number(body.object_id);
      activityData = await fetchStravaActivity(strava_id);
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
    const userText = message.text.trim();

    let reply;
    if (userText.startsWith('/sync30d')) {
      await sendTelegramMessage(chatId, 'Синхронизирую активности со Strava...');
      try {
        const count = await syncStravaActivities();
        reply = `Готово — синхронизировано ${count} активностей за последние 30 дней.`;
      } catch (err) {
        reply = `Ошибка синхронизации: ${err.message}`;
      }
    } else if (userText.startsWith('/feedback')) {
      reply = await getFeedbackResponse();
    } else if (userText.startsWith('/plan')) {
      reply = await getPlanResponse();
    } else {
      reply = await getCoachingResponse(userText);
    }

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
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

// GET /setup/strava-callback — Strava OAuth2 callback; stores tokens
app.get('/setup/strava-callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'No code' });
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
    const { error } = await supabase.from('strava_config').upsert({
      id: 1,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    });
    if (error) throw error;
    return res.json({ ok: true, athlete: data.athlete?.firstname ?? 'unknown' });
  } catch (err) {
    console.error('[strava-oauth] callback error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Strava helpers — direct OAuth2, no Composio dependency
// ---------------------------------------------------------------------------

async function getStravaToken() {
  const { data, error } = await supabase.from('strava_config').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('Strava not authorized — visit /setup/strava-oauth');

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
    await supabase.from('strava_config').upsert({
      id: 1,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: refreshed.expires_at,
    });
    return refreshed.access_token;
  }

  return data.access_token;
}

async function syncStravaActivities() {
  try {
    const token = await getStravaToken();
    const since = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since}&per_page=30`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Strava API ${r.status}`);
    const activities = await r.json();

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
    return activities.length;
  } catch (err) {
    console.error('[strava] sync error:', err.message);
    throw err;
  }
}

async function fetchStravaActivity(activityId) {
  try {
    const token = await getStravaToken();
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

async function getCoachingResponse(userText) {
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
    max_tokens: 500,
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
      const kj = a.raw?.kilojoules ? ` | ${Math.round(a.raw.kilojoules)} кДж` : '';

      const sportType = a.type ?? '';
      let activityTag = '';
      if ((sportType === 'Run' || sportType === 'TrailRun') && Number(a.raw?.workout_type) === 3) {
        activityTag = ' [ИНТЕРВАЛЫ]';
      } else if (sportType === 'WeightTraining') {
        activityTag = ' [СИЛОВАЯ]';
      }

      let lapsStr = '';
      const laps = a.raw?.laps;
      if (Array.isArray(laps) && laps.length > 1) {
        const valid = laps.filter((l) => l.distance > 0 && l.moving_time > 0);
        if (valid.length > 1) {
          const avgPace =
            valid.reduce((s, l) => s + l.moving_time / 60 / (l.distance / 1000), 0) /
            valid.length;
          const paceStr = `${Math.floor(avgPace)}:${String(Math.round((avgPace % 1) * 60)).padStart(2, '0')}`;
          const hrLaps = valid.filter((l) => l.average_heartrate);
          const hrStr =
            hrLaps.length > 0
              ? ` | HR ${Math.round(hrLaps.reduce((s, l) => s + l.average_heartrate, 0) / hrLaps.length)}`
              : '';
          lapsStr = ` | Лапы: ${valid.length}×[${paceStr} мин/км${hrStr}]`;
        }
      }

      return `${date} | ${sportType}${activityTag} | ${distKm} км | ${timeMin} мин | ${pace}${elev}${hr}${cadence}${power}${kj}${lapsStr}`;
    })
    .join('\n');
}

async function getFeedbackResponse() {
  const since = new Date();
  since.setDate(since.getDate() - 7);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) throw error;

  const summary = formatActivities(activities ?? []);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Тренировки за последние 7 дней:\n${summary}\n\nДай структурированный недельный фидбек. Без лишних вводных фраз и повторов — коротко в каждой секции.\n1. Итоги недели (объём, D+, типы тренировок)\n2. Что сделано хорошо\n3. На что обратить внимание\n\nФормат ответа: только HTML-теги <b> для выделения, эмодзи для разделов, никаких таблиц и markdown.`,
      },
    ],
  });

  return response.content[0].text;
}

async function getPlanResponse() {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) throw error;

  const summary = formatActivities(activities ?? []);

  const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const DAY_ABBR = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const today = new Date();
  const dow = today.getDay();
  const daysUntilMon = ((8 - dow) % 7) || 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMon);
  const weekDatesStr = DAY_ABBR.map((abbr, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return `${abbr} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }).join(', ');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Тренировки за последние 30 дней:\n${summary}\n\nДаты следующей недели: ${weekDatesStr}\n\nСоставь план на эту неделю. Для каждого дня используй заголовок формата <b>День недели, DD месяц</b> — затем тип, длительность/дистанция, пульсовые зоны, ключевой акцент. Без вводных фраз. Учитывай фазу (май 2026 — восстановление после MIUT) и нагрузку за 30 дней.\n\nФормат ответа: только HTML-теги <b> для выделения, эмодзи для разделов, никаких таблиц и markdown.`,
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
        { command: 'sync30d', description: 'Обновить данные из Strava' },
        { command: 'feedback', description: 'Фидбек по тренировкам за неделю' },
        { command: 'plan', description: 'План тренировок на неделю' },
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

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
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
app.listen(PORT, () => {
  console.log(`Sisu Coach listening on port ${PORT}`);
  registerTelegramCommands().catch((err) =>
    console.error('[telegram] registerTelegramCommands error:', err.message)
  );
});
