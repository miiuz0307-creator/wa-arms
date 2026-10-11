// Turn a Hebrew problem description into a known area. The area decides which logs are read and
// which part of the code Claude is pointed at. Nothing the user writes is ever executed.

const AREAS = {
  distribution: {
    label: 'הפצה ידנית',
    words: ['הפצה', 'הפצות', 'שליחה', 'שליחות', 'נשלח', 'נשלחו', 'קמפיין', 'תור', 'תקוע', 'תקועה', 'לא יוצא', 'לא יוצאות', 'מגבלה יומית'],
    services: ['engine'],
    logFilter: 'campaign',
    hint: 'engine/src/arm.js (send queue, claim_target), engine/src/assign.js, supabase functions claim_target / finalize_campaigns',
  },
  help: {
    label: 'הפצת עזרה',
    words: ['עזרה', 'סדרן', 'סדרנים', 'טריגר', 'נסיעה', 'נסיעות', 'מספר הלקוח', 'אימוג', 'ריאקציה', '⏳', '✅'],
    services: ['engine'],
    logFilter: 'help',
    hint: 'engine/src/help.js, engine/src/quote.js, engine/src/phones.js, processed_messages',
  },
  connection: {
    label: 'חיבור זרועות',
    words: ['חיבור', 'מחובר', 'מנותק', 'נותק', 'התנתק', 'qr', 'קיו אר', 'סריקה', 'זרוע', 'זרועות', 'מספר נחסם', 'חסימה', '403', '440'],
    services: ['engine'],
    logFilter: 'connection',
    hint: 'engine/src/arm.js (connect, onConnectionUpdate, reconnect), engine/src/authState.js',
  },
  login: {
    label: 'כניסה למערכת',
    words: ['התחברות', 'להתחבר', 'כניסה', 'נכנס', 'קוד גישה', 'קוד תחנה', 'סיסמה', 'סיסמא', 'נעול', 'לא מצליח להיכנס'],
    services: ['web'],
    logFilter: '',
    hint: 'web/app/login/page.tsx, web/lib/auth.tsx, supabase/migrations/*login*',
  },
  ui: {
    label: 'ממשק הניהול',
    words: ['ממשק', 'מסך', 'דף', 'עמוד', 'כפתור', 'לא נטען', 'לבן', 'אתר', 'טלפון לא מציג', 'תפריט', 'טבלה'],
    services: ['web'],
    logFilter: '',
    hint: 'web/app/(app)/*, web/components/*',
  },
  database: {
    label: 'מסד נתונים',
    words: ['מסד', 'נתונים', 'סופאבייס', 'supabase', 'איטי', 'איטית', 'קרס', 'קריסה', 'timeout'],
    services: ['engine', 'web'],
    logFilter: '',
    hint: 'supabase/migrations/*, testenv/*',
  },
};

const GENERAL = {
  label: 'כללי',
  services: ['engine', 'web'],
  logFilter: '',
  hint: 'start from README.md, then engine/src/index.js and web/app',
};

function classify(text) {
  const t = String(text || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [id, a] of Object.entries(AREAS)) {
    const score = a.words.reduce((s, w) => s + (t.includes(w.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  if (!best) return { id: 'general', ...GENERAL };
  return { id: best, ...AREAS[best] };
}

const areaLabel = (id) => (AREAS[id] || GENERAL).label;

module.exports = { classify, areaLabel, AREAS };
