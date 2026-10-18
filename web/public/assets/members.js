(() => {
  const api = async (url, options) => { const r = await fetch(url, options); const d = await r.json(); if (!r.ok || !d.ok) throw Error(d.error || '请求失败'); return d; };
  const status = text => { const s = document.getElementById('members-status'); if (s) s.textContent = text; };
  function render(members) {
    document.querySelectorAll('[data-member]').forEach(x => x.remove());
    const nav = document.getElementById('map-tabs');
    if (nav) for (const m of members.filter(m => m.registered)) {
      const a = document.createElement('a'); a.className = 'map-tab'; a.dataset.member = m.id; a.href = m.graphUrl; a.textContent = m.name; a.title = `${m.status} · ${m.active} 条活跃记忆`;
      if (document.body.classList.contains('embed')) a.href += '&embed=1';
      if (new URLSearchParams(location.search).get('instance') === m.name) a.classList.add('active'); nav.append(a);
    }
    const box = document.getElementById('members-list'); if (!box) return; box.replaceChildren();
    for (const m of members) {
      const row = document.createElement('div'); row.className = 'member-card';
      const title = document.createElement('strong'); title.textContent = m.name; row.append(title);
      for (const text of [`${m.registered ? '注册成员' : '运行配置'} · ${m.status} · ${m.projects} 项目 / ${m.active} 条活跃记忆`, m.dir, m.error].filter(Boolean)) { const p = document.createElement('p'); p.textContent = text; p.title = text; row.append(p); }
      const a = document.createElement('a'); a.href = m.graphUrl; a.textContent = '查看星图 →'; row.append(a);
      if (m.registered) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = '移除接入'; b.className = 'ghost';
        b.addEventListener('click', async () => { if (!confirm(`仅移除「${m.name}」的总图接入，不删除数据？`)) return; b.disabled = true; try { await api('/api/members/' + encodeURIComponent(m.id), { method: 'DELETE' }); await load(); status('已移除接入，记忆数据保留'); } catch (e) { status(e.message); b.disabled = false; } }); row.append(b);
      }
      box.append(row);
    }
  }
  let busy = false;
  async function load() { if (busy) return; busy = true; try { render((await api('/api/members')).members || []); } catch (e) { status(e.message); } finally { busy = false; } }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('member-add')?.addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target, button = f.querySelector('button'); button.disabled = true;
      try { await api('/api/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.elements.namedItem('name').value, dir: f.elements.namedItem('dir').value }) }); f.reset(); await load(); status('已接入，刷新总图即可看到新记忆体'); } catch (x) { status(x.message); } finally { button.disabled = false; }
    });
    document.getElementById('members-refresh')?.addEventListener('click', load);
    load(); setInterval(() => { if (!document.hidden) load(); }, 30000);
  });
})();
