// Every WhatsApp text the bot sends, in one place, in clear Hebrew.
const { areaLabel } = require('./classify');

const STATUS = {
  queued: 'בתור',
  investigating: 'בבדיקה',
  testing: 'בדיקות אוטומטיות',
  staging: 'בסביבת בדיקה',
  awaiting_approval: 'ממתין לאישור שלך',
  deploying: 'מעלה לשרת הפעיל',
  deployed: 'הועלה בהצלחה',
  no_fix: 'נבדק – אין תיקון בקוד',
  blocked: 'ממתין להשלמת הגדרות',
  rejected: 'נדחה',
  cancelled: 'בוטל',
  failed: 'נכשל',
  rolled_back: 'הוחזר לגרסה הקודמת',
};
const statusLabel = (s) => STATUS[s] || s;

const RISK = { low: 'נמוך', medium: 'בינוני', high: 'גבוה' };

const help = (isApprover) =>
  [
    '🤖 *BotiX AI Repair*',
    '',
    'השיחה פתוחה. כתבו לי מה לא עובד, במילים פשוטות. אפשר לצרף צילום מסך.',
    '(אחרי 30 דקות בלי הודעה השיחה נסגרת – כתבו שוב *עזרה* כדי לפתוח אותה.)',
    'לדוגמה: "ההפצה לא עובדת" או "זרוע 2 מנותקת".',
    '',
    '*פקודות:*',
    '• *סטטוס* – מה קורה עכשיו',
    '• *פניות* – 5 הפניות האחרונות',
    '• *פנייה 12* – פרטי פנייה',
    '• *בטל 12* – ביטול פנייה שעוד לא הועלתה',
    ...(isApprover
      ? ['• *אשר 123456* – אישור העלאה לשרת הפעיל (הקוד מגיע בהודעת הסיכום)', '• *דחה 12* – דחיית תיקון', '• *החזר 12* – חזרה לגרסה שלפני התיקון']
      : []),
    '• *עזרה* – ההודעה הזו',
  ].join('\n');

// The opening menu after "עזרה": tap a button, or type its number where buttons do not show.
const MENU = [
  { id: 'menu:report', title: '🛠 דיווח על תקלה', description: 'הבוט בודק ומתקן', digit: '1' },
  { id: 'menu:human', title: '👤 דבר עם נציג', description: 'הבוט מפסיק לענות לך', digit: '2' },
  { id: 'menu:status', title: '📋 פניות פתוחות', description: 'מה קורה עכשיו', digit: '3' },
  { id: 'menu:list', title: '🗂 פניות אחרונות', description: '5 הפניות האחרונות', digit: '4' },
  { id: 'menu:commands', title: '❓ כל הפקודות', description: 'רשימת פקודות לכתיבה', digit: '5' },
];
const MENU_BUTTON = 'פתיחת תפריט';
const menu = () =>
  [
    '🤖 *BotiX AI Repair*',
    '',
    'במה אפשר לעזור? לחצו על *פתיחת תפריט* ובחרו.',
    '',
    '_אם התפריט לא מופיע, כתבו את המספר:_',
    ...MENU.map((b) => `*${b.digit}* – ${b.title}`),
  ].join('\n');

const askReport = 'מעולה. כתבו לי מה לא עובד, במילים פשוטות. אפשר לצרף צילום מסך.\nלדוגמה: "ההפצה לא עובדת" או "זרוע 2 מנותקת".';

const toHuman =
  '👤 העברתי אותך לנציג.\nמעכשיו הבוט לא יענה בשיחה הזו – פשוט כתבו כאן ונציג יחזור אליכם.\nכדי לחזור לבוט כתבו *עזרה*.';

const humanRequested = (name, phone) => `👤 *${name}* (${phone}) ביקש לדבר עם נציג.\nהבוט הפסיק לענות לו – אפשר לענות לו ישירות מהטלפון של הבוט.`;

const received = (t, position) =>
  [
    `📥 קיבלתי. פנייה *#${t.id}*`,
    position > 0 ? `יש לפניה ${position} בתור. אעדכן כשאתחיל.` : 'מתחיל לבדוק בעוד רגע. אם יש צילום מסך – שלחו אותו עכשיו.',
  ].join('\n');

const imageAttached = (t) => `🖼️ צילום המסך צורף לפנייה *#${t.id}*.`;

const started = (t) => `🔍 התחלתי לבדוק את פנייה *#${t.id}* (${areaLabel(t.area)}).\nקורא לוגים ובודק את הקוד. זה יכול לקחת כמה דקות.`;

const noFix = (t) =>
  [
    `🔎 *פנייה #${t.id} – סיום בדיקה*`,
    '',
    `*מה מצאתי:* ${t.summary || 'לא נמצאה תקלה בקוד.'}`,
    t.root_cause ? `*הסיבה:* ${t.root_cause}` : '',
    '',
    'לא שיניתי שום דבר בקוד ובשרת.',
  ]
    .filter((l) => l !== '')
    .join('\n');

const testsFailed = (t, out) =>
  [
    `⚠️ *פנייה #${t.id}* – הכנתי תיקון, אבל הבדיקות האוטומטיות נכשלו גם אחרי ניסיון נוסף.`,
    '',
    `*התיקון שניסיתי:* ${t.summary || '-'}`,
    out ? `*שגיאה:* ${out}` : '',
    '',
    t.pr_url ? `השינוי שמור לעיון בלבד: ${t.pr_url}` : '',
    'שום דבר לא הועלה לשרת.',
  ]
    .filter(Boolean)
    .join('\n');

const blocked = (t, why) =>
  [
    `⏸️ *פנייה #${t.id}* – התיקון מוכן ועבר בדיקות, אבל ${why}`,
    '',
    `*התיקון:* ${t.summary || '-'}`,
    t.pr_url ? `לעיון: ${t.pr_url}` : '',
    'שום דבר לא הועלה לשרת.',
  ]
    .filter(Boolean)
    .join('\n');

function approvalRequest(t, code, minutes) {
  const tests = t.test_result || {};
  const staging = t.staging_result || {};
  return [
    `✅ *פנייה #${t.id} – תיקון מוכן לאישור*`,
    '',
    `*הבעיה:* ${t.description.slice(0, 200)}`,
    `*מה מצאתי:* ${t.summary || '-'}`,
    t.root_cause ? `*הסיבה:* ${t.root_cause}` : '',
    `*קבצים שהשתנו:* ${(t.files || []).join(', ') || '-'}`,
    t.diff_stat ? `*היקף:* ${t.diff_stat}` : '',
    `*רמת סיכון:* ${RISK[t.risk] || 'לא ידועה'}`,
    `*בדיקות אוטומטיות:* ${tests.ok ? 'עברו ✅' : 'לא עברו ❌'}`,
    `*סביבת בדיקה:* ${staging.ok ? 'עלה ותקין ✅' : staging.skipped ? 'דולג' : 'נכשל ❌'}`,
    ...(t.warnings?.length ? ['', '⚠️ ' + t.warnings.join('\n⚠️ ')] : []),
    t.pr_url ? `\nלצפייה בשינוי: ${t.pr_url}` : '',
    '',
    `להעלאה לשרת הפעיל שלחו: *אשר ${code}*`,
    `לדחייה: *דחה ${t.id}*`,
    `הקוד תקף ${minutes} דקות. בלי אישור – שום דבר לא עולה.`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const deploying = (t, by) => `🚀 אושר על ידי ${by}. מעלה את פנייה *#${t.id}* לשרת הפעיל…`;

const deployed = (t) =>
  [
    `🎉 *פנייה #${t.id} הועלתה לשרת הפעיל בהצלחה.*`,
    'השרת עלה ותקין.',
    '',
    `אם משהו השתבש – שלחו *החזר ${t.id}* ואחזיר לגרסה הקודמת.`,
  ].join('\n');

const deployFailed = (t, why, rolledBack) =>
  [
    `🚨 *פנייה #${t.id}* – ההעלאה לשרת הפעיל נכשלה.`,
    `*סיבה:* ${why}`,
    rolledBack ? '↩️ החזרתי אוטומטית לגרסה הקודמת.' : `לחזרה לגרסה הקודמת שלחו *החזר ${t.id}*.`,
  ].join('\n');

const rolledBack = (t, revertPr) =>
  [
    `↩️ *פנייה #${t.id}* – השרת הפעיל הוחזר לגרסה שלפני התיקון.`,
    revertPr ? `\nחשוב: הקוד בענף הראשי עדיין כולל את התיקון. פתחתי בקשה לביטול השינוי בקוד: ${revertPr}` : '',
    revertPr ? 'עד שתאשרו אותה, העלאה הבאה לענף הראשי תחזיר את התיקון.' : '',
  ]
    .filter(Boolean)
    .join('\n');

const failed = (t, why) => `❌ *פנייה #${t.id}* – הטיפול נעצר.\n*סיבה:* ${why}\nשום דבר לא הועלה לשרת.`;

const notAllowed = 'אין לך הרשאה לתת הוראות לבוט הזה.';
const approverOnly = 'רק מספר עם הרשאת "מאשר" יכול לבצע את הפעולה הזו.';
const badCode = 'הקוד לא נכון או שפג תוקפו. אפשר לבקש קוד חדש בשליחת *פנייה <מספר>*.';
const notFound = (id) => `לא מצאתי פנייה #${id}.`;
const tooShort = 'לא הבנתי. תארו את התקלה במשפט, או שלחו *עזרה*.';

function statusLine(t) {
  return `#${t.id} · ${statusLabel(t.status)} · ${t.description.slice(0, 60)}`;
}

function ticketDetails(t) {
  return [
    `*פנייה #${t.id}* – ${statusLabel(t.status)}`,
    `*תיאור:* ${t.description.slice(0, 300)}`,
    t.summary ? `*ממצאים:* ${t.summary}` : '',
    t.pr_url ? `*שינוי:* ${t.pr_url}` : '',
    t.error ? `*שגיאה:* ${t.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  statusLabel,
  help,
  MENU,
  MENU_BUTTON,
  menu,
  askReport,
  toHuman,
  humanRequested,
  received,
  imageAttached,
  started,
  noFix,
  testsFailed,
  blocked,
  approvalRequest,
  deploying,
  deployed,
  deployFailed,
  rolledBack,
  failed,
  notAllowed,
  approverOnly,
  badCode,
  notFound,
  tooShort,
  statusLine,
  ticketDetails,
};
