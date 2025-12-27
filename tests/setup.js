/**
 * Vitest Test Setup
 *
 * Configures the test environment for DOM testing with happy-dom.
 */

import { beforeEach, afterEach } from 'vitest';

// Reset DOM between tests
beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

afterEach(() => {
  // Clean up any global listeners or timers if needed
});
