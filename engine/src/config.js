const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`חסר משתנה סביבה: ${name}`);
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_ANON_KEY = required('SUPABASE_ANON_KEY');
const ENGINE_KEY = required('ENGINE_KEY'); // checked by public.is_engine() in the database
const SESSION_SECRET = required('SESSION_SECRET');

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'x-engine-key': ENGINE_KEY } },
});

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
// Baileys is very chatty; keep its own logger quiet
const waLogger = pino({ level: 'silent' });

module.exports = { db, log, waLogger, SESSION_SECRET };
