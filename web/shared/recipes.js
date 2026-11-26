/*
 * Which automation recipes the picker offers (window.EmailRecipes). Pure logic, tested in
 * test/recipes.test.js. A recipe "needs ChatDaddy" when a step syncs a ChatDaddy contact or
 * sends WhatsApp through the ChatDaddy provider. With the "Use ChatDaddy" switch on every
 * recipe is offered unchanged. With it off, a recipe with a `gpc` variant (title, desc, steps)
 * is offered as that GPC-WhatsApp variant and any other ChatDaddy-only recipe is hidden.
 * Automations that already exist are never touched.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmailRecipes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const needsChatDaddy = (steps) => (steps || []).some((s) => s.type === 'chatdaddy_contact' || (s.type === 'send_whatsapp' && s.provider === 'chatdaddy'));

  function visibleRecipes(recipes, chatdaddyOn, t = () => '') {
    if (chatdaddyOn) return recipes;
    return recipes.flatMap((r) => {
      if (r.gpc) return [{ ...r, title: r.gpc.title, desc: r.gpc.desc, steps: r.gpc.steps }];
      return needsChatDaddy(r.steps(t)) ? [] : [r];
    });
  }

  return { needsChatDaddy, visibleRecipes };
});
