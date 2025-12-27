/**
 * Reflex Core - Scheduler
 *
 * Implements the effect system and job scheduler with:
 * - Reactive effects with dependency tracking
 * - Double-buffered job queue for reduced GC pressure
 * - Batching support for grouping multiple state changes
 * - Computed properties with lazy evaluation
 * - Watchers with deep observation support
 */

import { ACTIVE, RUNNING, QUEUED, META } from './symbols.js';

type EffectRunner = (() => any) & {
  f: number;
  d: Array<Set<EffectRunner>>;
  s: ((effect: EffectRunner) => void) | null;
  kill: () => void;
  o?: any;
};

interface EffectOptions {
  lazy?: boolean;
  sched?: (effect: EffectRunner) => void;
}

interface WatchOptions {
  deep?: boolean;
  immediate?: boolean;
}

/**
 * Scheduler mixin for Reflex class.
 */
export const SchedulerMixin = {
  /**
   * Create a reactive effect
   * @param {Function} fn - Effect function to run
   * @param {Object} options - { lazy: boolean, sched: Function }
   * @returns {Function} Effect runner with kill() method
   */
  _ef(fn: () => any, o: EffectOptions = {}) {
    const self = this;
    const e: EffectRunner = () => {
      if (!(e.f & ACTIVE)) return;
      self._cln_eff(e);
      self._es.push(self._e);
      self._e = e;
      e.f |= RUNNING;
      try { return fn(); } finally { e.f &= ~RUNNING; self._e = self._es.pop(); }
    };
    e.f = ACTIVE;
    e.d = [];
    e.s = o.sched || null;
    e.kill = () => { self._cln_eff(e); e.f = 0; };
    if (!o.lazy) e();
    return e;
  },

  /**
   * Clean up effect dependencies
   */
  _cln_eff(e: EffectRunner) {
    for (let i = 0; i < e.d.length; i++) e.d[i].delete(e);
    e.d.length = 0;
  },

  /**
   * Queue a job for execution
   * Uses QUEUED flag for O(1) deduplication instead of Set.has()
   */
  _qj(j: EffectRunner) {
    if (j.f & QUEUED) return; // Already queued
    j.f |= QUEUED;            // Mark as queued
    // Push to the active queue (double-buffering for GC reduction)
    (this._qf ? this._qb : this._q).push(j);
    if (!this._p) { this._p = true; queueMicrotask(() => this._fl()); }
  },

  /**
   * Flush the job queue
   * Uses double-buffering to reduce GC pressure by reusing arrays
   */
  _fl() {
    this._p = false;
    // Swap buffers: process current, new jobs go to other
    const q = this._qf ? this._qb : this._q;
    this._qf = !this._qf; // Toggle active buffer

    for (let i = 0; i < q.length; i++) {
      const j = q[i];
      j.f &= ~QUEUED; // Clear queued flag before running
      try { j(); } catch (err) { this._handleError(err, j.o); }
    }

    // Clear without deallocation - reuses the same memory
    q.length = 0;
  },

  /**
   * Handle errors from scheduled jobs.
   */
  _handleError(err, scope) {
    let cur = scope;
    while (cur) {
      const handler = cur.catchError;
      if (typeof handler === 'function') {
        try { handler.call(cur, err); return; } catch (nextErr) { err = nextErr; }
      }
      cur = Object.getPrototypeOf(cur);
    }
    const onError = this.cfg?.onError;
    if (typeof onError === 'function') {
      onError(err);
      return;
    }
    console.error('Reflex: Error during flush:', err);
  },

  /**
   * Create a computed property with lazy evaluation
   */
  computed(fn: (state: any) => any) {
    const self = this;
    let v, dirty = true;
    const subs = new Set<EffectRunner>();

    const runner = this._ef(() => {
      v = fn(self.s);
      dirty = false;
      return v;
    }, {
      lazy: true,
      sched: () => {
        if (!dirty) {
          dirty = true;
          // Auto-refresh if unconsumed to maintain state consistency
          if (!subs.size) {
            self._qj(runner);
            return;
          }
          for (const e of subs) {
            if (e.f & ACTIVE && !(e.f & RUNNING)) {
              e.s ? e.s(e) : self._qj(e);
            }
          }
        }
      }
    });

    runner(); // Eager initial eval

    return {
      get value() {
        if (self._e && !subs.has(self._e)) {
          subs.add(self._e);
          self._e.d.push(subs);
        }
        if (dirty) runner();
        return v;
      }
    };
  },

  /**
   * Watch a reactive source and run callback on changes
   */
  watch(src: any, cb: (value: any, oldValue: any, onCleanup: (fn: () => void) => void) => void, opts: WatchOptions = {}) {
    const self = this;
    const getter = typeof src === 'function' ? src : () => src.value;
    let old, cleanup;

    const job = () => {
      const n = runner();
      if (opts.deep || !Object.is(n, old)) {
        if (cleanup) cleanup();
        cb(n, old, fn => { cleanup = fn; });
        old = opts.deep ? self._clone(n) : n;
      }
    };

    const runner = this._ef(() => {
      const v = getter();
      if (opts.deep) self._trv(v);
      return v;
    }, { lazy: true, sched: () => self._qj(job) });

    if (opts.immediate) job();
    else { old = runner(); if (opts.deep) old = this._clone(old); }

    return () => runner.kill();
  },

  /**
   * Batch multiple state changes and flush once
   */
  batch(fn: () => void) {
    this._b++;
    try { fn(); } finally {
      if (--this._b === 0) {
        try { this._fpt(); } catch (err) { console.error('Reflex: Error during batch flush:', err); }
      }
    }
  },

  /**
   * Execute callback after next DOM update
   */
  nextTick(fn?: () => void) {
    return new Promise<void>(r => queueMicrotask(() => { this._fl(); fn?.(); r(); }));
  },

  /**
   * Extract raw (non-reactive) object from proxy
   */
  toRaw<T>(o: T): T {
    if (o === null || typeof o !== 'object') return o;
    const m = o[META] || this._mf.get(o);
    return m ? m.r : o;
  },

  /**
   * Traverse value deeply for deep watch tracking
   */
  _trv(v: any, s = new Set<any>()) {
    if (v === null || typeof v !== 'object' || s.has(v)) return;
    s.add(v);
    const meta = v[META] || this._mf.get(v);
    if (meta) this._tk(meta, Symbol.for('rx.iterate'));
    if (Array.isArray(v)) {
      for (const i of v) this._trv(i, s);
    } else if (v instanceof Map || v instanceof Set) {
      v.forEach(x => this._trv(x, s));
    } else {
      for (const k in v) this._trv(v[k], s);
    }
  },

  /**
   * Deep clone a value for watch comparison
   */
  _clone(v, seen = new Map()) {
    v = this.toRaw(v);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return seen.get(v);
    if (v instanceof Date) return new Date(v);
    if (v instanceof RegExp) return new RegExp(v.source, v.flags);
    if (v instanceof Map) {
      const o = new Map(); seen.set(v, o);
      v.forEach((val, key) => o.set(key, this._clone(val, seen)));
      return o;
    }
    if (v instanceof Set) {
      const o = new Set(); seen.set(v, o);
      v.forEach(val => o.add(this._clone(val, seen)));
      return o;
    }
    if (Array.isArray(v)) {
      const o = []; seen.set(v, o);
      for (let i = 0; i < v.length; i++) o[i] = this._clone(v[i], seen);
      return o;
    }
    const o = {}; seen.set(v, o);
    for (const k in v) o[k] = this._clone(v[k], seen);
    return o;
  }
};
