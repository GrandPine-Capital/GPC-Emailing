/*
 * Renders a drag-and-drop email design ({ settings, blocks }) into
 * email-client-safe, table-based HTML. Shared by the server (Node) and the
 * browser builder (served at /shared/render-blocks.js -> window.EmailRender).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_SETTINGS = {
    width: 600,
    bgColor: '#f4f5f7',
    contentBg: '#ffffff',
    textColor: '#333333',
    linkColor: '#2563eb',
    fontFamily: 'Arial, Helvetica, sans-serif',
    preheader: '',
  };

  const BLOCK_DEFAULTS = {
    heading: { text: 'Your headline here', level: 1, align: 'left', color: '', padding: 16 },
    text: { html: '<p>Write something great. Use {{first_name}} to personalise.</p>', align: 'left', padding: 16 },
    image: { src: 'https://placehold.co/600x240/png?text=Image', alt: '', href: '', width: 100, padding: 0 },
    button: { text: 'Call to action', href: 'https://example.com', bg: '#2563eb', color: '#ffffff', align: 'center', radius: 6, padding: 16 },
    divider: { color: '#e5e7eb', thickness: 1, padding: 16 },
    spacer: { height: 24 },
    columns: { left: '<p>Left column</p>', right: '<p>Right column</p>', padding: 16 },
    social: { links: [{ network: 'Facebook', url: 'https://facebook.com' }, { network: 'LinkedIn', url: 'https://linkedin.com' }], align: 'center', padding: 16 },
    footer: { html: '<p>You received this email because you subscribed.<br><a href="{{unsubscribe_url}}">Unsubscribe</a></p>', padding: 16 },
    html: { html: '<p>Custom HTML</p>' },
  };

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const px = (n, d) => (Number.isFinite(Number(n)) ? Number(n) : d);

  function renderBlock(block, s) {
    const p = Object.assign({}, BLOCK_DEFAULTS[block.type] || {}, block.props || {});
    const pad = px(p.padding, 16);
    const cell = (inner, extra = '') =>
      `<tr><td style="padding:${pad}px 24px;${extra}">${inner}</td></tr>`;

    switch (block.type) {
      case 'heading': {
        const level = Math.min(Math.max(px(p.level, 1), 1), 3);
        const size = { 1: 28, 2: 22, 3: 18 }[level];
        return cell(
          `<h${level} style="margin:0;font-size:${size}px;line-height:1.3;color:${esc(p.color || s.textColor)};text-align:${esc(p.align)};font-family:${esc(s.fontFamily)};">${esc(p.text)}</h${level}>`,
        );
      }
      case 'text':
        return cell(
          `<div style="font-size:15px;line-height:1.6;color:${esc(s.textColor)};text-align:${esc(p.align)};font-family:${esc(s.fontFamily)};">${p.html || ''}</div>`,
        );
      case 'image': {
        const w = Math.round((px(p.width, 100) / 100) * (s.width - (pad ? 48 : 0)));
        let img = `<img src="${esc(p.src)}" alt="${esc(p.alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;margin:0 auto;">`;
        if (p.href) img = `<a href="${esc(p.href)}" target="_blank">${img}</a>`;
        return pad ? cell(img, 'text-align:center;') : `<tr><td style="text-align:center;">${img}</td></tr>`;
      }
      case 'button': {
        const btn = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${esc(p.align)}" style="margin:0 ${p.align === 'center' ? 'auto' : '0'};"><tr><td style="background:${esc(p.bg)};border-radius:${px(p.radius, 6)}px;"><a href="${esc(p.href)}" target="_blank" style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:bold;color:${esc(p.color)};text-decoration:none;font-family:${esc(s.fontFamily)};border-radius:${px(p.radius, 6)}px;">${esc(p.text)}</a></td></tr></table>`;
        return cell(btn, `text-align:${esc(p.align)};`);
      }
      case 'divider':
        return cell(`<div style="border-top:${px(p.thickness, 1)}px solid ${esc(p.color)};font-size:0;line-height:0;">&nbsp;</div>`);
      case 'spacer':
        return `<tr><td style="height:${px(p.height, 24)}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
      case 'columns': {
        const col = (html) =>
          `<td class="col" width="50%" valign="top" style="padding:0 8px;font-size:15px;line-height:1.6;color:${esc(s.textColor)};font-family:${esc(s.fontFamily)};">${html || ''}</td>`;
        return cell(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${col(p.left)}${col(p.right)}</tr></table>`);
      }
      case 'social': {
        const links = (p.links || [])
          .filter((l) => l && l.url)
          .map((l) => `<a href="${esc(l.url)}" target="_blank" style="display:inline-block;margin:0 6px;padding:6px 12px;background:#111827;color:#ffffff;border-radius:4px;text-decoration:none;font-size:13px;font-family:${esc(s.fontFamily)};">${esc(l.network || l.url)}</a>`)
          .join('');
        return cell(links, `text-align:${esc(p.align)};`);
      }
      case 'footer':
        return cell(
          `<div style="font-size:12px;line-height:1.5;color:#6b7280;text-align:center;font-family:${esc(s.fontFamily)};">${p.html || ''}</div>`,
        );
      case 'html':
        return `<tr><td>${p.html || ''}</td></tr>`;
      default:
        return '';
    }
  }

  function renderDesign(design) {
    const s = Object.assign({}, DEFAULT_SETTINGS, (design && design.settings) || {});
    const blocks = (design && design.blocks) || [];
    const rows = blocks.map((b) => renderBlock(b, s)).join('\n');
    const preheader = s.preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(s.preheader)}</div>`
      : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title></title>
<style>
  a { color: ${s.linkColor}; }
  p { margin: 0 0 12px; }
  @media only screen and (max-width: ${s.width + 20}px) {
    .container { width: 100% !important; }
    .col { display: block !important; width: 100% !important; padding: 0 0 12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${s.bgColor};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${s.bgColor};">
<tr><td align="center" style="padding:24px 8px;">
<table role="presentation" class="container" width="${s.width}" cellpadding="0" cellspacing="0" border="0" style="width:${s.width}px;max-width:100%;background:${s.contentBg};border-radius:8px;overflow:hidden;">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;
  }

  return { renderDesign, renderBlock, DEFAULT_SETTINGS, BLOCK_DEFAULTS };
});
