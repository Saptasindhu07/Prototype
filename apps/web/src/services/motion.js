const easing = 'cubic-bezier(.4, 0, .2, 1)';
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const initialsFor = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('');
export const visibleRect = (rect) => rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;

export function play(element, frames, options = {}) {
  if (!element || reducedMotion() || !element.animate) return null;
  const animation = element.animate(frames, { duration: 680, easing, ...options });
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const stop = () => { if (media.matches) animation.cancel(); };
  media.addEventListener('change', stop);
  animation.finished.catch(() => {}).finally(() => media.removeEventListener('change', stop));
  return animation;
}

function layer() {
  const node = document.createElement('div');
  node.className = 'motion-layer';
  node.setAttribute('aria-hidden', 'true');
  node.inert = true;
  if (typeof node.showPopover === 'function') node.setAttribute('popover', 'manual');
  document.body.append(node);
  if (node.hasAttribute('popover')) {
    try { node.showPopover(); } catch { node.removeAttribute('popover'); }
  }
  return node;
}

function removeAfter(animation, node, restore = () => {}) {
  let finished = false;
  const done = () => { if (finished) return; finished = true; restore(); node.remove(); };
  if (!animation) { done(); return () => {}; }
  animation.finished.catch(() => {}).finally(done);
  return () => { animation.cancel(); done(); };
}

export function captureOrigin(element) {
  if (!(element instanceof HTMLElement)) return null;
  const title = element.matches('.paper-link, .inline-link') ? element : element.closest('.research-card, .comparison-person')?.querySelector('h2, h3') || element;
  const rect = title.getBoundingClientRect();
  const style = getComputedStyle(title);
  const card = element.closest('.research-card, .comparison-person');
  return { element: title, rect, card, cardRect: card?.getBoundingClientRect(), text: title.textContent, fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight, fontFamily: style.fontFamily };
}

export function panelOrigin(dialog, origin, returning = false) {
  if (!origin || returning && !origin.card?.isConnected) return null;
  const rect = origin.card?.isConnected ? origin.card.getBoundingClientRect() : origin.cardRect;
  if (!visibleRect(rect)) return null;
  const target = dialog.getBoundingClientRect();
  const transform = `translate(${rect.left - target.left}px, ${rect.top - target.top}px) scale(${rect.width / target.width}, ${Math.max(.15, Math.min(1, rect.height / target.height))})`;
  dialog.style.setProperty('--return-transform', transform);
  return transform;
}

export function sharedTitle(origin, heading, reverse = false) {
  if (!origin || !heading || reducedMotion()) return null;
  const source = origin.element;
  const sourceRect = source?.isConnected ? source.getBoundingClientRect() : origin.rect;
  if (reverse && !source?.isConnected || !visibleRect(sourceRect) || heading.textContent !== origin.text) return null;
  const targetRect = heading.getBoundingClientRect();
  const targetStyle = getComputedStyle(heading);
  const sourceStyle = source?.isConnected ? getComputedStyle(source) : origin;
  const overlay = layer();
  const copy = document.createElement('div');
  copy.className = 'motion-title';
  copy.textContent = heading.textContent;
  copy.style.fontFamily = targetStyle.fontFamily;
  copy.style.color = targetStyle.color;
  overlay.append(copy);
  const from = { left: `${sourceRect.left}px`, top: `${sourceRect.top}px`, width: `${sourceRect.width}px`, fontSize: sourceStyle.fontSize, lineHeight: sourceStyle.lineHeight, fontWeight: sourceStyle.fontWeight };
  const to = { left: `${targetRect.left}px`, top: `${targetRect.top}px`, width: `${targetRect.width}px`, fontSize: targetStyle.fontSize, lineHeight: targetStyle.lineHeight, fontWeight: targetStyle.fontWeight };
  const sourceOpacity = source?.style.opacity;
  const headingOpacity = heading.style.opacity;
  heading.style.opacity = '0';
  if (source?.isConnected) source.style.opacity = '0';
  const animation = play(copy, reverse ? [to, from] : [from, to], { duration: reverse ? 540 : 760, fill: 'both' });
  return removeAfter(animation, overlay, () => {
    heading.style.opacity = headingOpacity;
    if (source) source.style.opacity = sourceOpacity || '';
  });
}

export function flyToTarget(source, findTarget, { label = '', paper = false, duration = 860, targetRect } = {}) {
  if (reducedMotion()) return;
  const start = source instanceof Element ? source.getBoundingClientRect() : source;
  if (!visibleRect(start)) return;
  let cancelled = false, cleanup = () => {}, pulse;
  const frame = requestAnimationFrame(() => {
    if (reducedMotion()) return;
    const target = findTarget();
    if (!target?.isConnected) return;
    const end = targetRect || target?.getBoundingClientRect();
    if (!visibleRect(end)) return;
    const overlay = layer();
    const token = document.createElement('span');
    token.className = paper ? 'motion-paper' : 'motion-avatar';
    token.textContent = label;
    overlay.append(token);
    const size = paper ? 28 : 36;
    const x0 = start.left + start.width / 2 - size / 2, y0 = start.top + start.height / 2 - size / 2;
    const x1 = end.left + end.width / 2 - size / 2, y1 = end.top + end.height / 2 - size / 2;
    const cx = (x0 + x1) / 2, cy = Math.max(12, Math.min(y0, y1) - Math.min(150, Math.abs(x1 - x0) * .2 + 60));
    const frames = Array.from({ length: 41 }, (_, index) => {
      const t = index / 40, inverse = 1 - t;
      const x = inverse * inverse * x0 + 2 * inverse * t * cx + t * t * x1;
      const y = inverse * inverse * y0 + 2 * inverse * t * cy + t * t * y1;
      return { offset: t, transform: `translate3d(${x}px, ${y}px, 0) scale(${1 - .45 * t}) rotate(${paper ? Math.sin(t * Math.PI) * -18 : 0}deg)`, opacity: t < .85 ? 1 : (1 - t) / .15 };
    });
    const animation = play(token, frames, { duration, fill: 'both' });
    animation?.finished.then(() => { if (!cancelled && target.isConnected) pulse = play(target, [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: .45 }, { transform: 'scale(1)' }], { duration: 460 }); }).catch(() => {});
    cleanup = removeAfter(animation, overlay);
  });
  return () => { cancelled = true; cancelAnimationFrame(frame); cleanup(); pulse?.cancel(); };
}

export function dissolveCard(snapshot) {
  if (reducedMotion() || !visibleRect(snapshot.rect)) return () => {};
  const overlay = layer();
  const copy = snapshot.clone;
  copy.classList.add('motion-card-ghost');
  copy.removeAttribute('id');
  copy.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  Object.assign(copy.style, { position: 'absolute', left: `${snapshot.rect.left}px`, top: `${snapshot.rect.top}px`, width: `${snapshot.rect.width}px`, height: `${snapshot.rect.height}px`, margin: '0', animation: 'none' });
  overlay.append(copy);
  return removeAfter(play(copy, [{ opacity: .65, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-8px) scale(.985)' }], { duration: 320, fill: 'both' }), overlay);
}
