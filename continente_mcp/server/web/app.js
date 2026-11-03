// Add-on ingress page. All text comes from i18n/<lang>.json; URLs are relative to the ingress path.
// A new token is shown once, here only: it is never stored by the page and never logged.
(() => {
  let t = {};
  const tr = (key, vars = {}) => (t[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const $ = id => document.getElementById(id);
  const api = async (method, path, body) => {
    const res = await fetch(`api/admin/${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : (method === 'GET' ? undefined : '{}') });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message_key ?? 'error.internal');
    return data;
  };
  const show = (key, vars) => { $('message').textContent = tr(key, vars); };
  const fail = e => show(e.message);
  const fmt = iso => (iso ? new Date(iso).toLocaleString(document.documentElement.lang) : tr('common.never'));
  const cell = text => { const td = document.createElement('td'); td.textContent = text; return td; };
  const button = (key, onClick) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = tr(key); b.addEventListener('click', onClick); return b; };

  async function loadLanguage(lang) {
    const file = lang.toLowerCase().startsWith('en') ? 'en' : 'pt-PT';
    t = await (await fetch(`web/i18n/${file}.json`)).json();
    document.documentElement.lang = file;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  }

  let polling;
  async function refresh() {
    const s = await api('GET', 'status');
    $('version').textContent = `${s.version} (continentept-mcp ${s.upstream.version})`;
    $('session').textContent = tr(s.session_valid === null ? 'status.session_unknown' : s.session_valid ? 'status.session_valid' : 'status.session_expired');
    $('session').className = s.session_valid ? 'ok' : s.session_valid === false ? 'warn' : '';
    $('queue').textContent = String(s.queue_length);
    $('endpoint').textContent = tr('status.endpoint_value', { host: location.hostname });
    $('checkout-on').hidden = !s.allow_checkout;
    $('account-state').textContent = s.credentials.configured ? tr('account.configured', { email: s.credentials.email }) : tr('account.missing');
    $('account-remove').hidden = !s.credentials.configured;
    renderTokens(s.tokens);
    renderRequests(s.requests);
    renderLogin(s.login);
    return s;
  }

  function renderTokens(tokens) {
    $('tokens').replaceChildren(...tokens.map(k => {
      const row = document.createElement('tr');
      row.append(cell(k.name), cell(tr(k.priority ? 'common.yes' : 'common.no')), cell(fmt(k.created_at)), cell(fmt(k.last_used_at)));
      const td = document.createElement('td');
      td.append(button('tokens.revoke', async () => {
        if (!confirm(tr('tokens.revoke_confirm', { name: k.name }))) return;
        try { await api('DELETE', `tokens/${encodeURIComponent(k.id)}`); show('tokens.revoked'); await refresh(); } catch (e) { fail(e); }
      }));
      row.append(td);
      return row;
    }));
  }

  function renderRequests(requests) {
    $('requests-section').hidden = requests.length === 0;
    $('requests').replaceChildren(...requests.map(r => {
      const row = document.createElement('tr');
      const fp = cell(r.fingerprint); fp.className = 'fp';
      row.append(cell(r.name), fp, cell(tr(r.priority ? 'common.yes' : 'common.no')));
      const td = document.createElement('td');
      td.append(
        button('requests.approve', async () => { try { await api('POST', 'requests/approve', { hash: r.hash }); show('requests.approved', { name: r.name }); await refresh(); } catch (e) { fail(e); } }),
        document.createTextNode(' '),
        button('requests.reject', async () => { try { await api('POST', 'requests/reject', { hash: r.hash }); await refresh(); } catch (e) { fail(e); } }),
      );
      row.append(td);
      return row;
    }));
  }

  function renderLogin(login) {
    $('login-state').textContent = tr(`login.state.${login.state}`);
    const active = login.state === 'starting' || login.state === 'waiting_user';
    $('login-start').hidden = active;
    $('login-cancel').hidden = !active;
    const frame = $('vnc');
    if (login.state === 'waiting_user' && frame.hidden) {
      const base = location.pathname.replace(/[^/]*$/, '').replace(/^\//, '');
      frame.src = `vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=${encodeURIComponent(base + 'vnc/websockify')}`;
      frame.hidden = false;
    } else if (!active) {
      frame.hidden = true;
      frame.removeAttribute('src');
    }
    clearTimeout(polling);
    if (active) polling = setTimeout(() => refresh().catch(fail), 2000);
  }

  const hideToken = () => { $('new-token-value').textContent = ''; $('new-token').hidden = true; };

  document.addEventListener('DOMContentLoaded', async () => {
    await loadLanguage(navigator.language || 'pt-PT');
    $('check-session').addEventListener('click', async () => { try { await api('POST', 'session/check'); show('status.checked'); await refresh(); } catch (e) { fail(e); } });
    $('account-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = ev.target;
      try { await api('PUT', 'credentials', { email: f.email.value, password: f.password.value }); f.reset(); show('account.saved'); await refresh(); } catch (e) { fail(e); }
    });
    $('account-remove').addEventListener('click', async () => { if (!confirm(tr('account.remove_confirm'))) return; try { await api('DELETE', 'credentials'); await refresh(); } catch (e) { fail(e); } });
    $('login-start').addEventListener('click', async () => { try { renderLogin(await api('POST', 'login')); } catch (e) { fail(e); } });
    $('login-cancel').addEventListener('click', async () => { try { await api('DELETE', 'login'); await refresh(); } catch (e) { fail(e); } });
    $('token-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = ev.target;
      try {
        const { token } = await api('POST', 'tokens', { name: f.name.value, priority: f.priority.checked });
        f.reset();
        $('new-token-value').textContent = token;
        $('new-token').hidden = false;
        await refresh();
      } catch (e) { fail(e); }
    });
    $('new-token-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('new-token-value').textContent); show('tokens.copied'); } catch { show('tokens.copy_failed'); } });
    $('new-token-hide').addEventListener('click', hideToken);
    refresh().catch(fail);
  });
})();
