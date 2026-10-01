/* Template editor: drag & drop block builder + HTML code editor with live preview. */
(() => {
  const { api, esc, toast, modal } = App;
  const R = window.EmailRender;

  const BLOCKS = [
    ['heading', 'H', 'Heading'], ['text', '¶', 'Text'], ['image', '🖼', 'Image'], ['button', '⏺', 'Button'],
    ['columns', '▥', '2 Columns'], ['divider', '—', 'Divider'], ['spacer', '↕', 'Spacer'], ['social', '#', 'Social links'],
    ['footer', '▁', 'Footer'], ['html', '</>', 'Custom HTML'],
  ];
  const LABEL = Object.fromEntries(BLOCKS.map(([t, , l]) => [t, l]));
  const FONTS = ['Arial, Helvetica, sans-serif', 'Georgia, serif', "'Trebuchet MS', sans-serif", 'Verdana, sans-serif', "'Times New Roman', serif", "'Courier New', monospace", "'Microsoft YaHei', 'PingFang SC', Arial, sans-serif"];
  const SAMPLE = { first_name: 'Alex', last_name: 'Tan', full_name: 'Alex Tan', email: 'alex@example.com', company: 'Sample Sdn Bhd', country: 'Malaysia', industry: 'Technology', sender_name: 'Your Company', company_address: '1 Example Street', unsubscribe_url: '#unsubscribe' };
  const sampleMerge = (html) => String(html).replace(/\{\{\s*([a-z_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_, k, f) => SAMPLE[k] ?? f ?? '');
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const SNIPPETS = {
    'Button': '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="background:#2563eb;border-radius:6px;"><a href="https://example.com" style="display:inline-block;padding:12px 28px;color:#ffffff;font-weight:bold;text-decoration:none;font-family:Arial,sans-serif;">Click here</a></td></tr></table>',
    'Image': '<img src="https://placehold.co/600x240/png" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;">',
    '2 columns': '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" valign="top" style="padding:8px;">Left</td><td width="50%" valign="top" style="padding:8px;">Right</td></tr></table>',
    'Unsubscribe footer': '<p style="font-size:12px;color:#888;text-align:center;">{{company_address}}<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
    'Basic email skeleton': '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body style="margin:0;padding:0;background:#f4f5f7;">\n<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">\n  <tr><td align="center" style="padding:24px 8px;">\n    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;">\n      <tr><td style="padding:24px;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#333;">\n        <p>Hi {{first_name|there}},</p>\n        <p>Your content here.</p>\n      </td></tr>\n    </table>\n  </td></tr>\n</table>\n</body>\n</html>',
  };

  async function renderEditor(root, idOrNew) {
    const meta = await App.getMeta();
    let tpl;
    if (idOrNew === 'new-dragdrop' || idOrNew === 'new-html') {
      const mode = idOrNew === 'new-html' ? 'html' : 'dragdrop';
      tpl = {
        id: null, name: 'Untitled template', subject: '', category: 'custom', mode,
        design: { settings: { ...R.DEFAULT_SETTINGS }, blocks: [] },
        html: mode === 'html' ? SNIPPETS['Basic email skeleton'] : '',
      };
    } else {
      tpl = await api.get(`/templates/${idOrNew}`);
      tpl.design = tpl.design || { settings: { ...R.DEFAULT_SETTINGS }, blocks: [] };
      tpl.design.settings = { ...R.DEFAULT_SETTINGS, ...tpl.design.settings };
    }
    let selected = null;
    let device = 'desktop';
    let dirty = false;
    const markDirty = () => { dirty = true; };
    const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);

    const mergeOptions = `<option value="">+ Merge tag</option>${meta.mergeTags.map((t) => `<option value="{{${t}}}">${t}</option>`).join('')}`;

    root.innerHTML = `
      <div class="page-head">
        <div><a href="#/templates">← Templates</a><h1>${tpl.id ? 'Edit template' : 'New template'}</h1></div>
        <div class="actions">
          <div class="props"><div class="seg" id="mode-seg"><button data-mode="dragdrop">Drag &amp; drop</button><button data-mode="html">HTML code</button></div></div>
          <div class="props"><div class="seg" id="device-seg"><button data-device="desktop" class="on">🖥 Desktop</button><button data-device="mobile">📱 Mobile</button></div></div>
          <button class="btn" id="btn-preview">Preview</button>
          <button class="btn" id="btn-test">Send test</button>
          <button class="btn primary" id="btn-save">Save</button>
        </div>
      </div>
      <div class="card builder-top">
        <div class="field" style="flex:1;min-width:200px"><label>Template name</label><input type="text" id="t-name" value="${esc(tpl.name)}"></div>
        <div class="field" style="flex:2;min-width:260px"><label>Default subject line</label><input type="text" id="t-subject" value="${esc(tpl.subject)}" placeholder="e.g. {{first_name}}, your update is here"></div>
        <div class="field"><label>&nbsp;</label><select id="subject-tag" style="width:auto">${mergeOptions}</select></div>
        <div class="field"><label>Category</label><input type="text" id="t-category" value="${esc(tpl.category)}" style="width:140px"></div>
      </div>
      <div id="editor-body"></div>`;

    const body = root.querySelector('#editor-body');
    root.querySelector('#t-name').oninput = (e) => { tpl.name = e.target.value; markDirty(); };
    root.querySelector('#t-subject').oninput = (e) => { tpl.subject = e.target.value; markDirty(); };
    root.querySelector('#t-category').oninput = (e) => { tpl.category = e.target.value; markDirty(); };
    root.querySelector('#subject-tag').onchange = (e) => {
      const input = root.querySelector('#t-subject');
      insertAtCursor(input, e.target.value);
      tpl.subject = input.value;
      e.target.value = '';
      markDirty();
    };

    function setSeg(id, attr, value) {
      root.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === value));
    }

    root.querySelectorAll('#mode-seg button').forEach((b) => (b.onclick = async () => {
      const mode = b.dataset.mode;
      if (mode === tpl.mode) return;
      if (mode === 'html') {
        if (!(await App.confirmDialog('Convert this design to HTML code? You can edit the code freely; switching back later wraps the code in a single Custom HTML block.', { okText: 'Convert to HTML', danger: false }))) return;
        tpl.html = R.renderDesign(tpl.design);
      } else {
        const inner = (tpl.html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, tpl.html])[1];
        tpl.design = { settings: { ...R.DEFAULT_SETTINGS }, blocks: inner.trim() ? [{ id: uid(), type: 'html', props: { html: inner } }] : [] };
      }
      tpl.mode = mode;
      markDirty();
      draw();
    }));
    root.querySelectorAll('#device-seg button').forEach((b) => (b.onclick = () => {
      device = b.dataset.device;
      setSeg('device-seg', 'device', device);
      draw();
    }));

    // ---------------------------------------------------------------- save / test / preview
    const currentHtml = () => (tpl.mode === 'html' ? tpl.html : R.renderDesign(tpl.design));

    async function save() {
      const payload = { name: tpl.name, subject: tpl.subject, category: tpl.category, mode: tpl.mode, design: tpl.design, html: tpl.html };
      const saved = tpl.id ? await api.put(`/templates/${tpl.id}`, payload) : await api.post('/templates', payload);
      if (!tpl.id) history.replaceState(null, '', `#/templates/${saved.id}`);
      tpl.id = saved.id;
      dirty = false;
      toast('Template saved');
    }
    root.querySelector('#btn-save').onclick = save;

    root.querySelector('#btn-preview').onclick = async () => {
      const r = await api.post('/templates/render', { mode: tpl.mode, design: tpl.design, html: tpl.html, subject: tpl.subject });
      modal(`<div class="row" style="align-items:center;margin-bottom:10px"><h2 style="margin:0;flex:1">Preview</h2>
        <div class="props"><div class="seg" id="pv-seg"><button class="on" data-w="100%">Desktop</button><button data-w="375px">Mobile</button></div></div>
        <button class="btn" data-close>Close</button></div>
        <p class="muted">Subject: <strong>${esc(r.subject || '(no subject)')}</strong> · sample contact: Alex Tan, Sample Sdn Bhd</p>
        <iframe class="preview-frame" id="pv"></iframe>`, {
        wide: true,
        onMount: (el) => {
          el.querySelector('#pv').srcdoc = r.preview;
          el.querySelectorAll('#pv-seg button').forEach((b) => (b.onclick = () => {
            el.querySelectorAll('#pv-seg button').forEach((x) => x.classList.toggle('on', x === b));
            el.querySelector('#pv').style.width = b.dataset.w;
            el.querySelector('#pv').style.margin = '0 auto';
            el.querySelector('#pv').style.display = 'block';
          }));
        },
      });
    };

    root.querySelector('#btn-test').onclick = () => {
      modal(`<h2>Send a test email</h2>
        <div class="field"><label>Send to</label><input type="email" id="test-to" placeholder="you@company.com"></div>
        <p class="hint">The template is saved first. Merge tags use the contact's data if the address exists in your contacts, otherwise sample data.</p>
        <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="send">Send test</button></div>`, {
        onMount: (el, close) => {
          el.querySelector('#send').onclick = async () => {
            await save();
            const r = await api.post(`/templates/${tpl.id}/test`, { email: el.querySelector('#test-to').value });
            toast(r.dryRun ? 'Dry-run mode: test email rendered but not delivered (configure SMTP in Settings).' : 'Test email sent');
            close();
          };
        },
      });
    };

    // ---------------------------------------------------------------- drawing
    function draw() {
      setSeg('mode-seg', 'mode', tpl.mode);
      if (tpl.mode === 'html') drawHtmlEditor();
      else drawBuilder();
    }

    // ---- HTML code mode
    function drawHtmlEditor() {
      body.innerHTML = `
        <div class="card" style="padding:10px 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select id="snippet" style="width:auto"><option value="">+ Insert snippet</option>${Object.keys(SNIPPETS).map((k) => `<option>${esc(k)}</option>`).join('')}</select>
          <select id="html-tag" style="width:auto">${mergeOptions}</select>
          <label class="btn sm" style="margin:0">Import .html file<input type="file" id="html-file" accept=".html,.htm,text/html" hidden></label>
          <span class="hint">Tip: use <code>{{first_name|there}}</code> for a fallback value. An unsubscribe link is added automatically if missing.</span>
        </div>
        <div class="html-editor">
          <textarea class="code" id="code" spellcheck="false"></textarea>
          <iframe class="preview-frame ${device === 'mobile' ? 'mobile' : ''}" id="live"></iframe>
        </div>`;
      const code = body.querySelector('#code');
      const live = body.querySelector('#live');
      code.value = tpl.html;
      const refresh = App.debounce(() => { live.srcdoc = sampleMerge(tpl.html); }, 250);
      live.srcdoc = sampleMerge(tpl.html);
      code.oninput = () => { tpl.html = code.value; markDirty(); refresh(); };
      code.onkeydown = (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          insertAtCursor(code, '  ');
          code.oninput();
        }
      };
      body.querySelector('#snippet').onchange = (e) => {
        if (!e.target.value) return;
        insertAtCursor(code, SNIPPETS[e.target.value]);
        e.target.value = '';
        code.oninput();
      };
      body.querySelector('#html-tag').onchange = (e) => {
        insertAtCursor(code, e.target.value);
        e.target.value = '';
        code.oninput();
      };
      body.querySelector('#html-file').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        code.value = await f.text();
        code.oninput();
      };
    }

    // ---- Drag & drop mode
    function drawBuilder() {
      body.innerHTML = `
        <div class="builder">
          <div class="card palette">
            <h3>Blocks</h3>
            <p class="hint" style="margin-top:0">Drag onto the email, or click to append.</p>
            ${BLOCKS.map(([t, ico, label]) => `<div class="pal-item" draggable="true" data-type="${t}"><span class="ico">${ico}</span>${label}</div>`).join('')}
          </div>
          <div class="canvas-wrap" id="canvas-wrap"><div class="canvas" id="canvas"></div></div>
          <div class="card props" id="props"></div>
        </div>`;

      body.querySelectorAll('.pal-item').forEach((p) => {
        p.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', `new:${p.dataset.type}`));
        p.addEventListener('click', () => addBlock(p.dataset.type, tpl.design.blocks.length));
      });
      const canvas = body.querySelector('#canvas');
      canvas.addEventListener('dragover', onDragOver);
      canvas.addEventListener('dragleave', (e) => { if (!canvas.contains(e.relatedTarget)) clearDropLine(); });
      canvas.addEventListener('drop', onDrop);
      canvas.addEventListener('click', onCanvasClick);
      canvas.addEventListener('dblclick', onCanvasDblClick);
      drawCanvas();
      drawProps();
    }

    function drawCanvas() {
      const canvas = body.querySelector('#canvas');
      if (!canvas) return;
      const s = tpl.design.settings;
      body.querySelector('#canvas-wrap').style.background = s.bgColor;
      canvas.style.width = `${s.width}px`;
      canvas.style.maxWidth = '100%';
      canvas.style.background = s.contentBg;
      canvas.style.fontFamily = s.fontFamily;
      canvas.classList.toggle('mobile', device === 'mobile');
      if (!tpl.design.blocks.length) {
        canvas.innerHTML = '<div class="empty-drop">Drag blocks here to start building your email</div>';
        return;
      }
      canvas.innerHTML = tpl.design.blocks.map((b, i) => `
        <div class="blk ${b.id === selected ? 'selected' : ''}" data-id="${b.id}" draggable="true">
          <span class="blk-label">${LABEL[b.type] || b.type}</span>
          <div class="blk-tools">
            <button data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-act="down" title="Move down" ${i === tpl.design.blocks.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-act="dup" title="Duplicate">⧉</button>
            <button data-act="del" class="del" title="Delete">✕</button>
          </div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${R.renderBlock(b, s)}</table>
        </div>`).join('');
      canvas.querySelectorAll('.blk').forEach((el) => {
        el.addEventListener('dragstart', (e) => {
          if (e.target.closest('[contenteditable="true"]')) return e.preventDefault();
          e.dataTransfer.setData('text/plain', `move:${el.dataset.id}`);
          e.dataTransfer.effectAllowed = 'move';
        });
      });
    }

    function dropIndex(e) {
      const blocks = [...body.querySelectorAll('#canvas .blk')];
      for (let i = 0; i < blocks.length; i++) {
        const r = blocks[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return i;
      }
      return blocks.length;
    }
    function clearDropLine() { body.querySelectorAll('.drop-line').forEach((l) => l.remove()); }
    function onDragOver(e) {
      e.preventDefault();
      const idx = dropIndex(e);
      const canvas = body.querySelector('#canvas');
      const blocks = canvas.querySelectorAll('.blk');
      clearDropLine();
      const line = document.createElement('div');
      line.className = 'drop-line';
      if (!blocks.length) return;
      if (idx < blocks.length) canvas.insertBefore(line, blocks[idx]);
      else canvas.appendChild(line);
    }
    function onDrop(e) {
      e.preventDefault();
      const data = e.dataTransfer.getData('text/plain');
      const idx = dropIndex(e);
      clearDropLine();
      if (data.startsWith('new:')) addBlock(data.slice(4), idx);
      else if (data.startsWith('move:')) {
        const from = tpl.design.blocks.findIndex((b) => b.id === data.slice(5));
        if (from < 0) return;
        const [blk] = tpl.design.blocks.splice(from, 1);
        tpl.design.blocks.splice(from < idx ? idx - 1 : idx, 0, blk);
        markDirty();
        drawCanvas();
      }
    }

    function addBlock(type, index) {
      const blk = { id: uid(), type, props: clone(R.BLOCK_DEFAULTS[type] || {}) };
      tpl.design.blocks.splice(index, 0, blk);
      selected = blk.id;
      markDirty();
      drawCanvas();
      drawProps();
    }

    function onCanvasClick(e) {
      if (e.target.closest('a') && !e.target.closest('[contenteditable="true"]')) e.preventDefault();
      const el = e.target.closest('.blk');
      const blocks = tpl.design.blocks;
      if (!el) {
        if (selected) { selected = null; drawCanvas(); drawProps(); }
        return;
      }
      const i = blocks.findIndex((b) => b.id === el.dataset.id);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'up' && i > 0) [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]];
      else if (act === 'down' && i < blocks.length - 1) [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]];
      else if (act === 'dup') {
        const copy = { ...clone(blocks[i]), id: uid() };
        blocks.splice(i + 1, 0, copy);
        selected = copy.id;
      } else if (act === 'del') {
        blocks.splice(i, 1);
        if (selected === el.dataset.id) selected = null;
      } else {
        if (selected === el.dataset.id) return;
        selected = el.dataset.id;
      }
      if (act) markDirty();
      drawCanvas();
      drawProps();
    }

    // Double-click a heading or text block to edit it directly on the canvas.
    function onCanvasDblClick(e) {
      const el = e.target.closest('.blk');
      const blk = el && tpl.design.blocks.find((b) => b.id === el.dataset.id);
      if (!blk || !['heading', 'text'].includes(blk.type)) return;
      const target = blk.type === 'heading' ? el.querySelector('h1,h2,h3') : el.querySelector('td > div');
      if (!target) return;
      el.setAttribute('draggable', 'false');
      target.contentEditable = 'true';
      target.focus();
      target.addEventListener('blur', () => {
        if (blk.type === 'heading') blk.props.text = target.textContent;
        else blk.props.html = target.innerHTML;
        markDirty();
        drawCanvas();
        drawProps();
      }, { once: true });
    }

    // ---------------------------------------------------------------- properties panel
    const f = {
      text: (k, label, v, ph = '') => `<div class="field"><label>${label}</label><input type="text" data-prop="${k}" value="${esc(v)}" placeholder="${esc(ph)}"></div>`,
      number: (k, label, v, min = 0, max = 2000) => `<div class="field"><label>${label}</label><input type="number" data-prop="${k}" value="${esc(v)}" min="${min}" max="${max}"></div>`,
      color: (k, label, v) => `<div class="field"><label>${label}</label><div class="color-row"><input type="color" data-prop="${k}" value="${esc(v || '#000000')}"><input type="text" data-prop="${k}" value="${esc(v)}"></div></div>`,
      select: (k, label, v, opts) => `<div class="field"><label>${label}</label><select data-prop="${k}">${opts.map((o) => `<option value="${esc(Array.isArray(o) ? o[0] : o)}" ${String(v) === String(Array.isArray(o) ? o[0] : o) ? 'selected' : ''}>${esc(Array.isArray(o) ? o[1] : o)}</option>`).join('')}</select></div>`,
      align: (k, v) => `<div class="field"><label>Alignment</label><div class="seg" data-seg="${k}">${['left', 'center', 'right'].map((a) => `<button type="button" data-v="${a}" class="${v === a ? 'on' : ''}">${a}</button>`).join('')}</div></div>`,
      html: (k, label, v, rows = 6) => `<div class="field"><label>${label}</label>
        <div class="mini-toolbar" data-for="${k}"><button type="button" data-wrap="b"><b>B</b></button><button type="button" data-wrap="i"><i>I</i></button><button type="button" data-wrap="u"><u>U</u></button><button type="button" data-wrap="a">Link</button><button type="button" data-wrap="p">¶</button><button type="button" data-wrap="br">↵</button><select data-tag>${mergeOptions}</select></div>
        <textarea class="code" rows="${rows}" data-prop="${k}">${esc(v)}</textarea></div>`,
    };

    function drawProps() {
      const panel = body.querySelector('#props');
      if (!panel) return;
      const blk = tpl.design.blocks.find((b) => b.id === selected);
      if (!blk) {
        const s = tpl.design.settings;
        panel.innerHTML = `<h3>Email settings</h3><p class="hint">Select a block on the canvas to edit it. Double-click text to edit inline.</p>
          ${f.text('preheader', 'Preheader (inbox preview text)', s.preheader)}
          ${f.number('width', 'Content width (px)', s.width, 320, 900)}
          ${f.color('bgColor', 'Background colour', s.bgColor)}
          ${f.color('contentBg', 'Content background', s.contentBg)}
          ${f.color('textColor', 'Text colour', s.textColor)}
          ${f.color('linkColor', 'Link colour', s.linkColor)}
          ${f.select('fontFamily', 'Font', s.fontFamily, FONTS)}`;
        bindProps(panel, s);
        return;
      }
      const p = blk.props = { ...R.BLOCK_DEFAULTS[blk.type], ...blk.props };
      let html = '';
      switch (blk.type) {
        case 'heading':
          html = f.text('text', 'Text', p.text) + f.select('level', 'Size', p.level, [[1, 'Large (H1)'], [2, 'Medium (H2)'], [3, 'Small (H3)']]) + f.align('align', p.align) + f.color('color', 'Colour (blank = default)', p.color);
          break;
        case 'text':
          html = f.html('html', 'Content (HTML allowed)', p.html, 10) + f.align('align', p.align);
          break;
        case 'image':
          html = `<div class="field"><label>Image</label><input type="text" data-prop="src" value="${esc(p.src)}" placeholder="https://…"><label class="btn sm" style="margin-top:6px">Upload image<input type="file" id="img-upload" accept="image/*" hidden></label></div>` +
            f.text('alt', 'Alt text', p.alt) + f.text('href', 'Link (optional)', p.href, 'https://') + f.number('width', 'Width (%)', p.width, 10, 100) + f.number('padding', 'Padding (px)', p.padding, 0, 60);
          break;
        case 'button':
          html = f.text('text', 'Label', p.text) + f.text('href', 'Link URL', p.href, 'https://') + f.color('bg', 'Button colour', p.bg) + f.color('color', 'Text colour', p.color) + f.align('align', p.align) + f.number('radius', 'Corner radius', p.radius, 0, 40);
          break;
        case 'columns':
          html = f.html('left', 'Left column', p.left) + f.html('right', 'Right column', p.right);
          break;
        case 'divider':
          html = f.color('color', 'Colour', p.color) + f.number('thickness', 'Thickness', p.thickness, 1, 10) + f.number('padding', 'Spacing', p.padding, 0, 60);
          break;
        case 'spacer':
          html = f.number('height', 'Height (px)', p.height, 4, 200);
          break;
        case 'social':
          html = `<div class="field"><label>Links <span class="hint">one per line: Name | URL</span></label><textarea rows="6" id="social-links">${esc((p.links || []).map((l) => `${l.network} | ${l.url}`).join('\n'))}</textarea></div>` + f.align('align', p.align);
          break;
        case 'footer':
          html = f.html('html', 'Footer content', p.html) + '<p class="hint">Keep <code>{{unsubscribe_url}}</code> in the footer.</p>';
          break;
        case 'html':
          html = f.html('html', 'Custom HTML', p.html, 16);
          break;
      }
      panel.innerHTML = `<div class="row" style="align-items:center;margin-bottom:10px"><h3 style="margin:0;flex:1">${LABEL[blk.type]}</h3><button class="btn sm" id="deselect">Email settings</button></div>${html}`;
      panel.querySelector('#deselect').onclick = () => { selected = null; drawCanvas(); drawProps(); };
      bindProps(panel, p);
      const social = panel.querySelector('#social-links');
      if (social) social.oninput = () => {
        p.links = social.value.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[1]).map(([network, url]) => ({ network, url }));
        markDirty();
        drawCanvas();
      };
      const up = panel.querySelector('#img-upload');
      if (up) up.onchange = async () => {
        const fd = new FormData();
        fd.append('file', up.files[0]);
        const r = await api('POST', '/uploads', fd);
        p.src = r.url;
        markDirty();
        drawCanvas();
        drawProps();
      };
    }

    function bindProps(panel, target) {
      const numeric = new Set(['width', 'padding', 'height', 'thickness', 'radius', 'level']);
      const set = (k, v) => {
        target[k] = numeric.has(k) ? Number(v) : v;
        panel.querySelectorAll(`[data-prop="${k}"]`).forEach((el) => { if (el.value !== String(v) && document.activeElement !== el) el.value = v; });
        markDirty();
        drawCanvas();
      };
      panel.querySelectorAll('[data-prop]').forEach((el) => el.addEventListener('input', () => set(el.dataset.prop, el.value)));
      panel.querySelectorAll('[data-seg]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        set(seg.dataset.seg, b.dataset.v);
      })));
      panel.querySelectorAll('.mini-toolbar').forEach((tb) => {
        const ta = panel.querySelector(`textarea[data-prop="${tb.dataset.for}"]`);
        tb.querySelectorAll('[data-wrap]').forEach((b) => (b.onclick = () => {
          const w = b.dataset.wrap;
          if (w === 'br') insertAtCursor(ta, '<br>');
          else if (w === 'a') {
            const url = prompt('Link URL', 'https://');
            if (!url) return;
            wrapSelection(ta, `<a href="${url}">`, '</a>');
          } else wrapSelection(ta, `<${w}>`, `</${w}>`);
          set(tb.dataset.for, ta.value);
        }));
        tb.querySelector('[data-tag]').onchange = (e) => {
          insertAtCursor(ta, e.target.value);
          e.target.value = '';
          set(tb.dataset.for, ta.value);
        };
      });
    }

    draw();
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }

  function insertAtCursor(el, text) {
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.focus();
  }
  function wrapSelection(el, before, after) {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    el.value = el.value.slice(0, s) + before + el.value.slice(s, e) + after + el.value.slice(e);
    el.selectionStart = s + before.length;
    el.selectionEnd = e + before.length;
    el.focus();
  }

  App.route(/^#\/templates\/(new-dragdrop|new-html|[\w-]+)$/, renderEditor);
})();
