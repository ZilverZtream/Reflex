/**
 * Vitest Test Setup
 *
 * Configures the test environment for DOM testing with happy-dom.
 */

import { beforeEach, afterEach } from 'vitest';
import DOMPurify from 'dompurify';
import { SafeHTML } from '../src/renderers/dom.js';

// Configure SafeHTML with DOMPurify for all tests
SafeHTML.configureSanitizer(DOMPurify);

// Make DOMPurify globally available for tests
globalThis.DOMPurify = DOMPurify;

// Reset DOM between tests
beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

afterEach(() => {
  // Clean up any global listeners or timers if needed
});
