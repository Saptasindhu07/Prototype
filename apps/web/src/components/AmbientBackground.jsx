import { useEffect, useRef } from 'react';

export default function AmbientBackground() {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    const light = root.querySelector('.ambient-pointer');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const fine = matchMedia('(hover: hover) and (pointer: fine)');
    let frame = 0, x = innerWidth / 2, y = innerHeight / 2, targetX = x, targetY = y;
    function stop() { cancelAnimationFrame(frame); frame = 0; light.style.opacity = '0'; }
    function drift() {
      x += (targetX - x) * .045; y += (targetY - y) * .045;
      light.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (Math.abs(x - targetX) + Math.abs(y - targetY) > .2) frame = requestAnimationFrame(drift);
      else frame = 0;
    }
    function move(event) {
      if (reduced.matches || !fine.matches || document.hidden || event.pointerType === 'touch') return;
      targetX = event.clientX; targetY = event.clientY;
      light.style.opacity = '1';
      if (!frame) frame = requestAnimationFrame(drift);
    }
    function visibility() { root.dataset.paused = String(document.hidden); if (document.hidden) stop(); }
    function preference() { if (reduced.matches || !fine.matches) stop(); }
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', stop);
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', preference); fine.addEventListener('change', preference);
    visibility();
    return () => {
      stop(); window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', stop);
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', preference); fine.removeEventListener('change', preference);
    };
  }, []);
  return <div className="ambient-background" ref={ref} aria-hidden="true"><div className="ambient-flow ambient-flow-one"/><div className="ambient-flow ambient-flow-two"/><div className="ambient-pointer"/></div>;
}
