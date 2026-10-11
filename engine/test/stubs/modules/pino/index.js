// silent logger that keeps the last lines for assertions
const lines = [];
function pino() {
  const mk = (lvl) => (obj, msg) => lines.push({ lvl, obj, msg: typeof obj === 'string' ? obj : msg });
  return { trace: mk('trace'), debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal'), child() { return this; }, level: 'silent' };
}
pino.lines = lines;
module.exports = pino;
