/* Draws the static icons in index.html (kept out of the page: the CSP allows no inline script). */
document.querySelectorAll('[data-icon]').forEach(function (el) {
  el.innerHTML = Icons.svg(el.dataset.icon, Number(el.dataset.size) || 20);
});
