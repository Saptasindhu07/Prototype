import { Component, createRef } from 'react';
import { dissolveCard, play, reducedMotion } from '../services/motion';

export default class MotionList extends Component {
  ref = createRef();
  effects = [];
  stop = () => { this.effects.forEach(cancel => cancel()); this.effects = []; };
  items = () => [...this.ref.current.querySelectorAll(':scope > [data-record-key]')];
  componentDidMount() { this.arrange(new Map()); }
  getSnapshotBeforeUpdate(previous) {
    if (previous.layoutKey === this.props.layoutKey) return null;
    const active = document.activeElement;
    return { height: this.ref.current.getBoundingClientRect().height, active: this.ref.current.contains(active) ? active : null, items: new Map(this.items().map(node => [node.dataset.recordKey, { rect: node.getBoundingClientRect(), clone: node.cloneNode(true) }])) };
  }
  componentDidUpdate(previous, state, snapshot) {
    if (!snapshot) return;
    this.stop();
    this.arrange(snapshot.items, snapshot.height);
    if (snapshot.active && !snapshot.active.isConnected) this.ref.current.querySelector('.save-button, button')?.focus({ preventScroll: true });
  }
  componentWillUnmount() { this.stop(); }
  track(animation) { if (animation) this.effects.push(() => animation.cancel()); }
  arrange(previous, oldHeight) {
    if (reducedMotion()) return;
    const items = this.items();
    const current = new Set(items.map(node => node.dataset.recordKey));
    previous.forEach((snapshot, key) => { if (!current.has(key)) this.effects.push(dissolveCard(snapshot)); });
    const height = this.ref.current.getBoundingClientRect().height;
    if (oldHeight && Math.abs(height - oldHeight) > 1) {
      const list = this.ref.current;
      list.dataset.reflow = 'true';
      const animation = play(list, [{ height: `${oldHeight}px` }, { height: `${height}px` }], { duration: 720 });
      let finished = false;
      const finish = () => { if (finished) return; finished = true; delete list.dataset.reflow; };
      if (animation) {
        this.effects.push(() => { animation.cancel(); finish(); });
        animation.finished.catch(() => {}).finally(finish);
      } else finish();
    }
    items.forEach((node, index) => {
      const old = previous.get(node.dataset.recordKey)?.rect;
      const next = node.getBoundingClientRect();
      if (old) {
        const x = old.left - next.left, y = old.top - next.top;
        if (Math.abs(x) + Math.abs(y) > 1) this.track(play(node, [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 720 }));
      } else this.track(play(node, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 680, delay: Math.min(index, 5) * 45, fill: 'backwards' }));
    });
  }
  render() {
    const { children, label, busy = false } = this.props;
    return <section ref={this.ref} className="results-list motion-list" aria-label={label} aria-busy={busy} data-loading={busy} inert={busy || undefined}>{children}</section>;
  }
}
