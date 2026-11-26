/*
 * Subscribe forms: opt-in forms with a hosted page and an embed snippet. A sign-up joins the
 * form's lists and tags, after confirming by email when the form uses double opt-in.
 */
(() => {
  const { api, esc, toast, modal, confirmDialog, fmtDate, statusBadge, icon } = App;
  const FIELDS = [['first_name', 'First name', 'text'], ['last_name', 'Last name', 'text'], ['phone', 'Phone', 'tel'], ['company', 'Company', 'text']];

  /** The HTML to paste into another website: a plain form that posts to the hosted address. */
  function embedCode(f) {
    const rows = [
      `<form action="${f.url}" method="post">`,
      `  <label>Email <input type="email" name="email" required></label>`,
      ...FIELDS.filter(([k]) => (f.fields || []).includes(k)).map(([k, label, type]) => `  <label>${label} <input type="${type}" name="${k}"></label>`),
      `  <div style="position:absolute;left:-9999px" aria-hidden="true"><input type="text" name="hp" tabindex="-1" autocomplete="off"></div>`,
      ...(f.consent_text ? [`  <label><input type="checkbox" name="consent" value="yes" required> ${esc(f.consent_text)}</label>`] : []),
      `  <button type="submit">${esc(f.button_text || 'Subscribe')}</button>`,
      `</form>`,
    ];
    return rows.join('\n');
  }

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed - select and copy manually', 'error'); }
  };

  function shareModal(f) {
    modal(`<div class="row" style="align-items:center;margin-bottom:6px"><h2 style="margin:0;flex:1">Share "${esc(f.name)}"</h2><button class="btn icon ghost" data-close>${icon('x', 18)}</button></div>
      <div class="field">${App.fieldLabel('Hosted page', `<button type="button" class="link-btn" id="cp-url">${icon('copy', 14)}Copy</button>`)}
        <input type="text" class="mono" id="f-url" value="${esc(f.url)}" readonly>
        <div class="hint">Link to this page from your website, social profiles, a QR code or an email signature. <a href="${esc(f.url)}" target="_blank" rel="noopener">Open it</a>.</div></div>
      <div class="field">${App.fieldLabel('Embed on your website', `<button type="button" class="link-btn" id="cp-code">${icon('copy', 14)}Copy</button>`)}
        <textarea class="code" id="f-code" rows="9" readonly>${esc(embedCode(f))}</textarea>
        <div class="hint">Paste into any page and style it as you like; keep the field names. The hidden <code>hp</code> field stops spam bots. After signing up, people see the thank-you message${f.redirect_url ? ' and go on to your redirect page' : ', or the page you set as redirect'}.
          A script can also POST JSON to the same address with <code>Accept: application/json</code>.</div></div>
      <div class="foot"><button class="btn primary" data-close>Done</button></div>`, {
      wide: true,
      onMount: (el) => {
        el.querySelector('#cp-url').onclick = () => copy(f.url);
        el.querySelector('#cp-code').onclick = () => copy(embedCode(f));
      },
    });
  }

  function editModal(f, lists, facets, done) {
    const isNew = !f;
    f = f || { name: '', title: 'Subscribe to our newsletter', description: '', button_text: 'Subscribe', fields: ['first_name'], list_ids: [], tags: [], double_optin: true, consent_text: '', success_message: '', redirect_url: '', status: 'active' };
    modal(`<h2>${isNew ? 'New subscribe form' : 'Edit form'}</h2><div id="ff">
      <div class="field"><label>Form name <span class="hint">(internal)</span></label><input type="text" name="name" value="${esc(f.name)}" placeholder="Website footer"></div>
      <div class="row"><div class="field"><label>Heading</label><input type="text" name="title" value="${esc(f.title)}"></div>
        <div class="field" style="max-width:200px"><label>Button text</label><input type="text" name="button_text" value="${esc(f.button_text)}"></div></div>
      <div class="field"><label>Introduction <span class="hint">(optional)</span></label><input type="text" name="description" value="${esc(f.description)}" placeholder="Monthly market insights. No spam."></div>
      <div class="field"><label>Ask for <span class="hint">(besides the email address)</span></label>${FIELDS.map(([k, label]) => `<label class="check"><input type="checkbox" name="fields" data-group value="${k}" ${(f.fields || []).includes(k) ? 'checked' : ''}> ${label}</label>`).join('')}</div>
      <div class="field"><label>Add subscribers to</label>${lists.map((l) => `<label class="check"><input type="checkbox" name="list_ids" data-group value="${l.id}" ${(f.list_ids || []).includes(l.id) ? 'checked' : ''}> ${esc(l.name)}</label>`).join('') || '<span class="muted">No lists yet. <a href="#/lists">Create one</a>.</span>'}</div>
      <div class="field"><label>Tag them <span class="hint">(comma separated)</span></label><input type="text" name="tags" list="form-tags" value="${esc((f.tags || []).join(', '))}" placeholder="newsletter, website">
        <datalist id="form-tags">${(facets.tags || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
      <label class="check"><input type="checkbox" name="double_optin" ${f.double_optin ? 'checked' : ''}> <span><b>Double opt-in</b>: send a confirmation email; people are subscribed (and join the lists and tags) only after they click the link in it</span></label>
      <div class="hint" style="margin:-2px 0 12px">Recommended: it proves the address belongs to the person, keeps typos and bots off your list and gives you a record of consent. The email is the template chosen in <a href="#/settings/sending">Settings → Sending → Subscription &amp; opt-in</a>.</div>
      <div class="field"><label>Consent checkbox <span class="hint">(optional; people must tick it)</span></label><input type="text" name="consent_text" value="${esc(f.consent_text)}" placeholder="I agree to receive emails from GrandPine Capital."></div>
      <div class="row"><div class="field"><label>Thank-you message <span class="hint">(optional)</span></label><input type="text" name="success_message" value="${esc(f.success_message)}" placeholder="Thanks! Please check your inbox to confirm."></div>
        <div class="field"><label>…or redirect to <span class="hint">(optional)</span></label><input type="url" name="redirect_url" value="${esc(f.redirect_url)}" placeholder="https://yoursite.com/thank-you"></div></div>
      <div class="field" style="max-width:220px"><label>Status</label><select name="status"><option value="active" ${f.status !== 'paused' ? 'selected' : ''}>Active: accepting sign-ups</option><option value="paused" ${f.status === 'paused' ? 'selected' : ''}>Paused: closed</option></select></div>
      </div><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go">Save form</button></div>`, {
      wide: true,
      onMount: (el, close) => (el.querySelector('#go').onclick = async () => {
        const data = App.formData(el.querySelector('#ff'));
        data.fields = data.fields || [];
        data.list_ids = data.list_ids || [];
        const saved = isNew ? await api.post('/forms', data) : await api.put(`/forms/${f.id}`, data);
        close();
        toast('Form saved');
        done(saved, isNew);
      }),
    });
  }

  App.route(/^#\/forms$/, async (root) => {
    const [forms, lists, facets] = await Promise.all([api.get('/forms'), api.get('/lists'), api.get('/contacts/facets')]);
    const listName = Object.fromEntries(lists.map((l) => [l.id, l.name]));
    root.innerHTML = `
      ${App.pageHead({
        title: 'Subscribe forms',
        subtitle: 'Collect opt-ins on a hosted page or your own website, with double opt-in confirmation.',
        actions: `<a class="btn" href="#/automations/new/form_welcome">${icon('zap', 17)}Welcome automation</a><button class="btn primary" id="new">${icon('plus', 17)}New form</button>`,
      })}
      <div class="card table-wrap">${forms.length ? `<table class="data"><thead><tr><th>Form</th><th>Status</th><th>Opt-in</th><th>Adds to</th><th class="right">Sign-ups</th><th>Created</th><th></th></tr></thead><tbody>
        ${forms.map((f, i) => `<tr><td><b>${esc(f.name)}</b><div class="muted" style="font-size:12px">${esc(f.title)}</div></td>
          <td>${statusBadge(f.status)}</td><td>${f.double_optin ? '<span class="badge green">Double opt-in</span>' : '<span class="badge">Single opt-in</span>'}</td>
          <td>${(f.list_ids || []).map((id) => `<span class="badge">${esc(listName[id] || id)}</span>`).join(' ')} ${(f.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
          <td class="right">${f.submissions}</td><td class="nowrap">${fmtDate(f.created_at)}</td>
          <td class="nowrap right"><button class="btn sm" data-share="${i}">Link &amp; embed code</button> <button class="btn sm" data-edit="${i}">Edit</button> <button class="btn sm danger" data-del="${i}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No forms yet. Create one to let people subscribe themselves.</div>'}</div>
      <div class="card"><h2>How opt-in works</h2>
        <ol style="margin:0;padding-left:20px;line-height:1.9">
          <li>Someone fills in a form (the hosted page, or the snippet embedded on your website).</li>
          <li>With <b>double opt-in</b> they get a confirmation email and stay <span class="badge yellow">pending</span>, unmailed, until they click the link. Without it they are subscribed at once.</li>
          <li>On subscribing they join the form's lists and tags, which start any <a href="#/automations">automation</a> triggered by <b>Form submitted</b>, <b>Subscription confirmed</b>, <b>Added to a list</b> or <b>Tag added</b>.</li>
          <li>Every email carries an unsubscribe link and a preference page where they can leave individual public <a href="#/lists">lists</a>.</li>
        </ol></div>`;
    const reload = (saved, isNew) => { App.navigate(); if (isNew && saved) shareModal(saved); };
    root.querySelector('#new').onclick = () => editModal(null, lists, facets, reload);
    root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editModal(forms[Number(b.dataset.edit)], lists, facets, reload)));
    root.querySelectorAll('[data-share]').forEach((b) => (b.onclick = () => shareModal(forms[Number(b.dataset.share)])));
    root.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const f = forms[Number(b.dataset.del)];
      if (await confirmDialog(`Delete the form "${f.name}"? Its page and any embedded copies stop accepting sign-ups; the contacts are kept.`)) {
        await api.del(`/forms/${f.id}`);
        App.navigate();
      }
    }));
  });
})();
