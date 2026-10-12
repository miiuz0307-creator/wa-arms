// BotiX AI Repair – admin screen (no build step, no external scripts).
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const main = $('#main');
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : '');
  let pollTimer = null;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Botix': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') {
      showLogin();
      throw new Error('נדרשת כניסה');
    }
    if (!res.ok) throw new Error(data.error || 'שגיאה');
    return data;
  }

  // ---------- auth ----------
  function showLogin() {
    clearInterval(pollTimer);
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#password').focus();
  }
  function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    route();
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
      $('#password').value = '';
      showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------- helpers ----------
  const STATUS_TONE = {
    queued: 'info', investigating: 'info', testing: 'info', staging: 'info', deploying: 'info',
    awaiting_approval: 'warn', blocked: 'warn',
    deployed: 'ok', no_fix: '', rejected: '', cancelled: '',
    failed: 'bad', rolled_back: 'warn',
  };
  const badge = (t) => `<span class="badge ${STATUS_TONE[t.status] ?? ''}">${esc(t.status_label)}</span>`;
  const WA = {
    connected: ['ok', 'מחובר'],
    qr: ['warn', 'ממתין לסריקה'],
    connecting: ['info', 'מתחבר…'],
    disconnected: ['', 'לא מחובר'],
    error: ['bad', 'שגיאה'],
  };

  function poll(fn, ms = 4000) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden) fn().catch(() => {});
    }, ms);
  }

  // ---------- pages ----------
  async function home() {
    const s = await api('/api/state');
    const [tone, label] = WA[s.wa.state] || ['', s.wa.state];
    const tickets = (await api('/api/tickets')).slice(0, 6);
    const ready = s.readiness.filter((r) => r.ok).length;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>לוח בקרה</h1><div class="muted">בוט התיקונים של BotiX · <span class="ltr">${esc(s.repo)}</span></div></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${s.counts.open}</b><span>פניות פתוחות</span></div>
        <div class="stat"><b>${s.counts.awaiting}</b><span>ממתינות לאישור</span></div>
        <div class="stat"><b>${ready}/${s.readiness.length}</b><span>הגדרות מוכנות</span></div>
      </div>
      <div class="grid two">
        <section class="card">
          <h2>חיבור WhatsApp</h2>
          <div class="conn">
            <div class="conn-info">
              <p><span class="badge ${tone}">${label}</span>
              ${s.wa.me ? ` &nbsp;מספר הבוט: <b class="ltr">${esc(s.wa.me)}</b>` : ''}</p>
              ${s.wa.state === 'connected' ? (s.wa.group ? `<p>קבוצת פיקוד: <b>${esc(s.wa.group)}</b> ✅</p>` : `<div class="warnbox">כדי שהבוט יקבל הודעות בצורה אמינה: צרו קבוצת WhatsApp בשם <b>BotiX תיקונים</b>, צרפו אליה את מספר הבוט, וכתבו שם.</div>`) : ''}
              ${s.wa.error ? `<div class="warnbox">${esc(s.wa.error)}</div>` : ''}
              ${s.wa.state === 'qr' ? `<ol class="steps"><li>פתחו את WhatsApp בטלפון של מספר הבוט</li><li>הגדרות ← מכשירים מקושרים ← קישור מכשיר</li><li>סרקו את הקוד</li></ol>` : ''}
              <div class="actions">
                ${['disconnected', 'error'].includes(s.wa.state) ? `<button class="btn primary" id="wa-connect">📱 חיבור WhatsApp</button>` : ''}
                ${['connected', 'qr', 'connecting'].includes(s.wa.state) ? `<button class="btn" id="wa-pause">ניתוק זמני</button>` : ''}
                ${s.wa.state === 'connected' ? `<button class="btn danger" id="wa-logout">ניתוק ומחיקת החיבור</button>` : ''}
              </div>
            </div>
            ${s.wa.qr ? `<div class="qr"><img alt="קוד QR לחיבור WhatsApp" src="${s.wa.qr}"></div>` : ''}
          </div>
        </section>
        <section class="card">
          <h2>מוכנות המערכת</h2>
          ${s.readiness
            .map(
              (r) => `<div class="check"><i>${r.ok ? '✅' : '⚪'}</i><div><b>${esc(r.label)}</b>${r.ok ? '' : `<small>${esc(r.hint)}</small>`}</div></div>`,
            )
            .join('')}
        </section>
      </div>
      <section class="card mt">
        <h2>פניות אחרונות</h2>
        ${ticketTable(tickets)}
      </section>`;
    $('#wa-connect')?.addEventListener('click', () => act('/api/wa/connect', {}, 'מתחבר… ה-QR יופיע בעוד רגע'));
    $('#wa-pause')?.addEventListener('click', () => act('/api/wa/disconnect', { logout: false }, 'נותק זמנית'));
    $('#wa-logout')?.addEventListener('click', () => {
      if (confirm('לנתק את מספר הבוט ולמחוק את החיבור? יהיה צריך לסרוק QR מחדש.')) act('/api/wa/disconnect', { logout: true }, 'החיבור נמחק');
    });
    bindRows();
    poll(home, s.wa.state === 'qr' || s.wa.state === 'connecting' ? 2500 : 6000);
  }

  async function act(path, body, okMsg) {
    try {
      const r = await api(path, { method: 'POST', body });
      toast(r.message || okMsg);
      route();
    } catch (e) {
      toast(e.message);
    }
  }

  function ticketTable(list) {
    if (!list.length) return `<div class="empty">עוד אין פניות. שלחו לבוט בוואטסאפ תיאור של תקלה.</div>`;
    return `<table class="table responsive"><thead><tr><th>#</th><th>תיאור</th><th>תחום</th><th>ביקש</th><th>מצב</th><th>נפתח</th></tr></thead><tbody>
      ${list
        .map(
          (t) => `<tr class="clickable" data-id="${t.id}">
          <td data-l="#">${t.id}</td>
          <td data-l="תיאור"><div class="desc">${esc(t.description)}</div></td>
          <td data-l="תחום">${esc(t.area_label || '—')}</td>
          <td data-l="ביקש">${esc(t.requester_name || '')} <span class="muted ltr">${esc(t.requester_display)}</span></td>
          <td data-l="מצב">${badge(t)}</td>
          <td data-l="נפתח">${fmt(t.created_at)}</td></tr>`,
        )
        .join('')}</tbody></table>`;
  }
  const bindRows = () => main.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/ticket/${tr.dataset.id}`)));

  async function tickets() {
    const list = await api('/api/tickets');
    main.innerHTML = `<div class="page-head"><div><h1>פניות</h1><div class="muted">כל התקלות שדווחו לבוט וטופלו</div></div></div>
      <section class="card">${ticketTable(list)}</section>`;
    bindRows();
    poll(tickets, 6000);
  }

  async function ticket(id) {
    const { ticket: t, events } = await api(`/api/tickets/${id}`);
    const tests = t.test_result?.steps || [];
    const dep = t.deploy || {};
    main.innerHTML = `
      <div class="page-head">
        <div><h1>פנייה #${t.id}</h1><div class="muted">${fmt(t.created_at)} · ${esc(t.requester_name || '')} <span class="ltr">${esc(t.requester_display)}</span></div></div>
        <a class="btn small" href="#/tickets">→ חזרה לפניות</a>
      </div>
      <div class="grid two">
        <section class="card">
          <h2>פרטים</h2>
          <dl class="kv">
            <dt>מצב</dt><dd>${badge(t)}</dd>
            <dt>תיאור</dt><dd>${esc(t.description)}</dd>
            <dt>תחום</dt><dd>${esc(t.area_label || '—')}</dd>
            <dt>צילומי מסך</dt><dd>${t.images}</dd>
            ${t.summary ? `<dt>מה נמצא</dt><dd>${esc(t.summary)}</dd>` : ''}
            ${t.root_cause ? `<dt>הסיבה</dt><dd>${esc(t.root_cause)}</dd>` : ''}
            ${t.files?.length ? `<dt>קבצים</dt><dd><span class="ltr">${t.files.map(esc).join('<br>')}</span></dd>` : ''}
            ${t.diff_stat ? `<dt>היקף</dt><dd>${esc(t.diff_stat)}</dd>` : ''}
            ${t.branch ? `<dt>ענף</dt><dd><span class="ltr">${esc(t.branch)}</span></dd>` : ''}
            ${t.pr_url ? `<dt>השינוי ב-GitHub</dt><dd><a href="${esc(t.pr_url)}" target="_blank" rel="noopener">פתיחה</a></dd>` : ''}
            ${tests.length ? `<dt>בדיקות</dt><dd>${tests.map((s) => `${s.ok ? '✅' : '❌'} ${esc(s.name)}`).join('<br>')}</dd>` : ''}
            ${t.staging_result ? `<dt>סביבת בדיקה</dt><dd>${t.staging_result.ok ? (t.staging_result.skipped ? 'דולג' : '✅ תקין') : `❌ ${esc(t.staging_result.reason || 'לא מוגדרת')}`}</dd>` : ''}
            ${dep.by ? `<dt>הועלה</dt><dd>${fmt(dep.at)} · אושר ע"י ${esc(dep.by)}</dd>` : ''}
            ${dep.rollback ? `<dt>הוחזר</dt><dd>${fmt(dep.rollback.at)} · ${esc(dep.rollback.by)}${dep.rollback.revertPr ? ` · <a href="${esc(dep.rollback.revertPr)}" target="_blank" rel="noopener">ביטול בקוד</a>` : ''}</dd>` : ''}
            ${t.cost_usd ? `<dt>עלות Claude</dt><dd><span class="ltr">$${Number(t.cost_usd).toFixed(2)}</span></dd>` : ''}
          </dl>
          ${(t.warnings || []).map((w) => `<div class="warnbox">⚠️ ${esc(w)}</div>`).join('')}
          ${t.error ? `<div class="warnbox">${esc(t.error)}</div>` : ''}
          <div class="actions">
            ${['queued', 'investigating', 'testing', 'staging'].includes(t.status) ? `<button class="btn" data-act="cancel">עצירת הטיפול</button>` : ''}
            ${['awaiting_approval', 'blocked'].includes(t.status) ? `<button class="btn" data-act="reject">דחיית התיקון</button>` : ''}
            ${['deployed', 'failed'].includes(t.status) && dep.prev ? `<button class="btn danger" data-act="rollback">↩️ חזרה לגרסה הקודמת</button>` : ''}
          </div>
          ${t.status === 'awaiting_approval' ? `<p class="muted">האישור להעלאה לשרת הפעיל נעשה רק בוואטסאפ, עם הקוד החד-פעמי שנשלח למאשרים.</p>` : ''}
        </section>
        <section class="card">
          <h2>מה קרה</h2>
          <ul class="timeline">
            ${events
              .map((e) => `<li class="${/fail|denied|rejected|locked/.test(e.type) ? 'bad' : ''}"><time>${fmt(e.created_at)} · ${esc(actorName(e.actor))}</time>${esc(e.message)}</li>`)
              .join('') || '<li>אין עדיין אירועים</li>'}
          </ul>
        </section>
      </div>`;
    main.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'rollback') {
          const c = prompt('חזרה לגרסה הקודמת תשנה את השרת הפעיל.\nלאישור הקלידו: החזר');
          if (c !== 'החזר') return;
          return act(`/api/tickets/${t.id}/rollback`, { confirm: c });
        }
        if (confirm(a === 'cancel' ? 'לעצור את הטיפול בפנייה?' : 'לדחות את התיקון?')) act(`/api/tickets/${t.id}/${a}`, {});
      }),
    );
    poll(() => ticket(id), ['queued', 'investigating', 'testing', 'staging', 'deploying'].includes(t.status) ? 4000 : 15000);
  }

  const actorName = (a) => {
    const known = { system: 'מערכת', claude: 'Claude', admin: 'מנהל' }[a];
    if (known) return known;
    const m = /^972(\d{2})(\d{7})$/.exec(a || '');
    return m ? `0${m[1]}-${m[2]}` : a;
  };

  async function numbers() {
    const list = await api('/api/numbers');
    main.innerHTML = `
      <div class="page-head"><div><h1>מספרים מאושרים</h1><div class="muted">רק המספרים האלה יכולים לתת הוראות לבוט</div></div></div>
      <section class="card">
        <h2>הוספת מספר</h2>
        <form id="add" class="form-row">
          <label>מספר טלפון<input name="phone" inputmode="tel" placeholder="050-1234567" required></label>
          <label>שם<input name="name" placeholder="מיכאל"></label>
          <label>הרשאה<select name="role"><option value="requester">מבקש – מדווח על תקלות</option><option value="approver">מאשר – גם מאשר העלאה</option></select></label>
          <button class="btn primary" type="submit">הוספה</button>
        </form>
      </section>
      <section class="card mt">
        ${
          list.length
            ? `<table class="table responsive"><thead><tr><th>שם</th><th>מספר</th><th>הרשאה</th><th>פעיל</th><th></th></tr></thead><tbody>
          ${list
            .map(
              (n) => `<tr><td data-l="שם">${esc(n.name || '—')}</td><td data-l="מספר"><span class="ltr">${esc(n.display)}</span></td>
              <td data-l="הרשאה"><select data-role="${n.id}"><option value="requester" ${n.role === 'requester' ? 'selected' : ''}>מבקש</option><option value="approver" ${n.role === 'approver' ? 'selected' : ''}>מאשר</option></select></td>
              <td data-l="פעיל"><input type="checkbox" data-active="${n.id}" ${n.active ? 'checked' : ''} class="chk"></td>
              <td><button class="btn danger small" data-del="${n.id}">הסרה</button></td></tr>`,
            )
            .join('')}</tbody></table>`
            : '<div class="empty">עוד לא הוספתם מספרים. בלי מספר מאושר הבוט לא יענה לאף אחד.</div>'
        }
      </section>`;
    $('#add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/api/numbers', { method: 'POST', body: Object.fromEntries(f) });
        toast('המספר נוסף');
        numbers();
      } catch (err) {
        toast(err.message);
      }
    });
    main.querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', () => api(`/api/numbers/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }).then(() => toast('עודכן'), (e) => toast(e.message))));
    main.querySelectorAll('[data-active]').forEach((c) => c.addEventListener('change', () => api(`/api/numbers/${c.dataset.active}`, { method: 'PATCH', body: { active: c.checked } }).then(() => toast('עודכן'), (e) => toast(e.message))));
    main.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('להסיר את המספר?')) return;
        await api(`/api/numbers/${b.dataset.del}`, { method: 'DELETE' }).catch((e) => toast(e.message));
        numbers();
      }),
    );
    clearInterval(pollTimer);
  }

  async function log() {
    const list = await api('/api/events?limit=300');
    main.innerHTML = `<div class="page-head"><div><h1>יומן פעולות</h1><div class="muted">כל פעולה של הבוט, של Claude ושל המנהלים</div></div></div>
      <section class="card">${
        list.length
          ? `<table class="table responsive"><thead><tr><th>זמן</th><th>מי</th><th>פנייה</th><th>מה קרה</th></tr></thead><tbody>
        ${list
          .map(
            (e) => `<tr><td data-l="זמן">${fmt(e.created_at)}</td><td data-l="מי"><span class="ltr">${esc(actorName(e.actor))}</span></td>
            <td data-l="פנייה">${e.ticket_id ? `<a href="#/ticket/${e.ticket_id}">#${e.ticket_id}</a>` : '—'}</td><td data-l="מה קרה">${esc(e.message)}</td></tr>`,
          )
          .join('')}</tbody></table>`
          : '<div class="empty">היומן ריק</div>'
      }</section>`;
    poll(log, 10000);
  }

  // ---------- router ----------
  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [, page, id] = h.split('/');
    const name = page || 'home';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'ticket' ? 'tickets' : name)));
    try {
      if (name === 'tickets') await tickets();
      else if (name === 'ticket') await ticket(Number(id));
      else if (name === 'numbers') await numbers();
      else if (name === 'log') await log();
      else await home();
    } catch (e) {
      if (e.message !== 'נדרשת כניסה') main.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`;
    }
  }
  window.addEventListener('hashchange', route);

  api('/api/state').then(showApp, () => showLogin());
})();
