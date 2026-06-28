'use strict';
const { anthropic, supabase } = require('../lib/clients');
const { metrics } = require('../lib/metrics');
const { checkRateLimit } = require('../lib/rateLimit');

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
  if (error) metrics.supabase.errors_total++;
  const profileText = data?.profile_text?.trim() ||
    'No athlete profile set. Ask the user to run /profile to share their background and goals.';
  const prompt = FORMATTING_RULES + '\n\n' + profileText;
  systemPromptCache.set(chatId, prompt);
  console.log('[prompt] loaded from Supabase, length:', prompt.length);
  return prompt;
}

function clearSystemPromptCache(chatId) {
  systemPromptCache.delete(chatId);
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

async function getCoachingResponse(userText, userId, chatId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: activities, error } = await supabase
    .from('activities')
    .select('strava_id, type, distance_m, moving_time_s, started_at, raw')
    .eq('user_id', userId)
    .gte('started_at', since.toISOString())
    .order('started_at', { ascending: false });

  if (error) {
    metrics.supabase.errors_total++;
    throw error;
  }

  const summary = formatActivities(activities ?? []);
  if (!checkRateLimit(userId, 'freetext')) return 'Daily limit reached (20 requests). Try again tomorrow.';
  const systemPrompt = await getSystemPrompt(chatId);

  metrics.claude.calls_total++;
  const t0 = Date.now();
  let response;
  try {
    response = await anthropic.messages.create({
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
  } catch (err) {
    metrics.claude.errors_total++;
    throw err;
  }
  const latency = Date.now() - t0;
  metrics.claude.latency_ms_last = latency;
  if (metrics.claude.latency_last10.length >= 10) metrics.claude.latency_last10.shift();
  metrics.claude.latency_last10.push(latency);
  metrics.claude.tokens_input += response.usage.input_tokens;
  metrics.claude.tokens_output += response.usage.output_tokens;
  console.log(`[claude] call command=freetext latency_ms=${latency} tokens_in=${response.usage.input_tokens} tokens_out=${response.usage.output_tokens}`);

  return response.content[0].text;
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

  if (error) {
    metrics.supabase.errors_total++;
    throw error;
  }

  const summary = formatActivities(activities ?? []);
  if (!checkRateLimit(userId, 'feedback')) return 'Daily limit reached (20 requests). Try again tomorrow.';
  const systemPrompt = await getSystemPrompt(chatId);

  metrics.claude.calls_total++;
  const t0 = Date.now();
  let response;
  try {
    response = await anthropic.messages.create({
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
  } catch (err) {
    metrics.claude.errors_total++;
    throw err;
  }
  const latency = Date.now() - t0;
  metrics.claude.latency_ms_last = latency;
  if (metrics.claude.latency_last10.length >= 10) metrics.claude.latency_last10.shift();
  metrics.claude.latency_last10.push(latency);
  metrics.claude.tokens_input += response.usage.input_tokens;
  metrics.claude.tokens_output += response.usage.output_tokens;
  console.log(`[claude] call command=feedback latency_ms=${latency} tokens_in=${response.usage.input_tokens} tokens_out=${response.usage.output_tokens}`);

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

  if (error) {
    metrics.supabase.errors_total++;
    throw error;
  }

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

  if (!checkRateLimit(userId, 'plan')) return 'Daily limit reached (20 requests). Try again tomorrow.';
  const systemPrompt = await getSystemPrompt(chatId);

  metrics.claude.calls_total++;
  const t0 = Date.now();
  let response;
  try {
    response = await anthropic.messages.create({
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
  } catch (err) {
    metrics.claude.errors_total++;
    throw err;
  }
  const latency = Date.now() - t0;
  metrics.claude.latency_ms_last = latency;
  if (metrics.claude.latency_last10.length >= 10) metrics.claude.latency_last10.shift();
  metrics.claude.latency_last10.push(latency);
  metrics.claude.tokens_input += response.usage.input_tokens;
  metrics.claude.tokens_output += response.usage.output_tokens;
  console.log(`[claude] call command=plan latency_ms=${latency} tokens_in=${response.usage.input_tokens} tokens_out=${response.usage.output_tokens}`);

  return response.content[0].text;
}

module.exports = {
  getSystemPrompt,
  clearSystemPromptCache,
  getCoachingResponse,
  getFeedbackResponse,
  getPlanResponse,
  formatActivities,
};
