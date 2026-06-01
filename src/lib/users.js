'use strict';
const { supabase } = require('./clients');
const { metrics } = require('./metrics');

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
  if (insertError) {
    metrics.supabase.errors_total++;
    throw insertError;
  }
  return created;
}

module.exports = { findOrCreateUser };
