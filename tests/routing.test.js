/**
 * Routing & History Tests
 *
 * "Reality is the Spec." These tests ensure the app reacts to navigation.
 *
 * Tests:
 * - Popstate reactivity (browser back/forward)
 * - Anchor interception (SPA navigation)
 *
 * If these tests fail, Reflex needs to handle browser navigation correctly.
 * DO NOT modify tests to pass on broken behavior. Fix the framework.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

// Helper to dispatch click events
function dispatchClick(el, options = {}) {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window,
    ...options
  });
  el.dispatchEvent(event);
  return event;
}

// Helper to wait for DOM operations
async function tick(app, times = 2) {
  for (let i = 0; i < times; i++) {
    await app.nextTick();
  }
}

// Helper to dispatch popstate event
// Note: happy-dom doesn't properly pass state through PopStateEvent (always undefined)
// We need to manually set the state property for the tests to work
function dispatchPopstate(state = null) {
  const event = new PopStateEvent('popstate', { state });
  // Happy-dom sets event.state to undefined regardless of what we pass
  // We need to manually define the state property
  Object.defineProperty(event, 'state', { value: state, writable: false });
  window.dispatchEvent(event);
  return event;
}

describe('Routing & History', () => {
  let originalLocation;
  let originalPushState;
  let originalReplaceState;
  let historyStack;
  let currentIndex;

  beforeEach(() => {
    document.body.innerHTML = '';

    // Save original history methods
    originalPushState = window.history.pushState.bind(window.history);
    originalReplaceState = window.history.replaceState.bind(window.history);

    // Mock history stack for testing
    historyStack = [{ url: window.location.href, state: null }];
    currentIndex = 0;

    // Mock pushState
    window.history.pushState = vi.fn((state, title, url) => {
      currentIndex++;
      historyStack = historyStack.slice(0, currentIndex);
      historyStack.push({ state, url });
    });

    // Mock replaceState
    window.history.replaceState = vi.fn((state, title, url) => {
      historyStack[currentIndex] = { state, url };
    });
  });

  afterEach(() => {
    // Restore original methods
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
  });

  describe('Popstate Reactivity', () => {
    /**
     * CRITICAL REQUIREMENT:
     * When the user navigates with browser back/forward buttons,
     * the UI must update to reflect the new state.
     *
     * Reflex needs a mechanism (like window.addEventListener('popstate'))
     * to update the UI if state was derived from the URL.
     */

    it('should support listening to popstate events', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span id="current-page" m-text="currentPage"></span>
        </div>
      `;

      const app = new Reflex({ currentPage: 'home' });
      app.mount(document.getElementById('app'));
      await tick(app);

      // Set up popstate listener (this is how an app would handle routing)
      const popstateHandler = vi.fn((e) => {
        if (e.state && e.state.page) {
          app.s.currentPage = e.state.page;
        }
      });
      window.addEventListener('popstate', popstateHandler);

      expect(document.getElementById('current-page').textContent).toBe('home');

      // Simulate navigation
      window.history.pushState({ page: 'about' }, '', '/about');
      app.s.currentPage = 'about';
      await tick(app);

      expect(document.getElementById('current-page').textContent).toBe('about');

      // Simulate back button (popstate)
      dispatchPopstate({ page: 'home' });
      await tick(app);

      expect(popstateHandler).toHaveBeenCalled();
      expect(app.s.currentPage).toBe('home');
      expect(document.getElementById('current-page').textContent).toBe('home');

      window.removeEventListener('popstate', popstateHandler);
    });

    it('should update UI when popstate carries state data', async () => {
      document.body.innerHTML = `
        <div id="app">
          <div m-if="route === 'home'" id="home-view">Home Page</div>
          <div m-if="route === 'products'" id="products-view">Products Page</div>
          <div m-if="route === 'contact'" id="contact-view">Contact Page</div>
        </div>
      `;

      const app = new Reflex({ route: 'home' });

      // Simulate a router setup
      const router = {
        init(app) {
          window.addEventListener('popstate', (e) => {
            if (e.state && e.state.route) {
              app.s.route = e.state.route;
            }
          });
        },
        push(route) {
          window.history.pushState({ route }, '', `/${route}`);
          app.s.route = route;
        }
      };

      router.init(app);
      app.mount(document.getElementById('app'));
      await tick(app);

      expect(document.getElementById('home-view')).toBeTruthy();
      expect(document.getElementById('products-view')).toBeNull();

      // Navigate to products
      router.push('products');
      await tick(app);

      expect(document.getElementById('home-view')).toBeNull();
      expect(document.getElementById('products-view')).toBeTruthy();

      // Navigate to contact
      router.push('contact');
      await tick(app);

      expect(document.getElementById('contact-view')).toBeTruthy();

      // Simulate pressing back button
      dispatchPopstate({ route: 'products' });
      await tick(app);

      expect(document.getElementById('products-view')).toBeTruthy();
      expect(document.getElementById('contact-view')).toBeNull();
    });

    it('should handle popstate with null state', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span m-text="page"></span>
        </div>
      `;

      const app = new Reflex({ page: 'initial' });
      app.mount(document.getElementById('app'));
      await tick(app);

      const handler = vi.fn((e) => {
        // Handle null state gracefully
        if (e.state === null) {
          app.s.page = 'default';
        }
      });

      window.addEventListener('popstate', handler);

      // Dispatch popstate with null state
      dispatchPopstate(null);
      await tick(app);

      expect(handler).toHaveBeenCalled();
      expect(app.s.page).toBe('default');

      window.removeEventListener('popstate', handler);
    });

    it('should work with URL-derived reactive state', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span id="query-display" m-text="searchQuery"></span>
        </div>
      `;

      const app = new Reflex({ searchQuery: '' });

      // Simulate reading from URL
      const parseQuery = () => {
        const params = new URLSearchParams(window.location.search);
        return params.get('q') || '';
      };

      // Set up URL-reactive state
      window.addEventListener('popstate', () => {
        app.s.searchQuery = parseQuery();
      });

      app.mount(document.getElementById('app'));
      await tick(app);

      // Simulate URL change with query
      window.history.pushState({}, '', '?q=test');
      app.s.searchQuery = 'test';
      await tick(app);

      expect(document.getElementById('query-display').textContent).toBe('test');

      // Simulate back to empty query
      window.history.pushState({}, '', '/');
      dispatchPopstate({});
      app.s.searchQuery = '';
      await tick(app);

      expect(document.getElementById('query-display').textContent).toBe('');
    });

    it('should handle rapid popstate events', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span id="counter" m-text="count"></span>
        </div>
      `;

      const app = new Reflex({ count: 0 });

      window.addEventListener('popstate', (e) => {
        if (e.state && typeof e.state.count === 'number') {
          app.s.count = e.state.count;
        }
      });

      app.mount(document.getElementById('app'));
      await tick(app);

      // Rapid popstate events
      dispatchPopstate({ count: 1 });
      dispatchPopstate({ count: 2 });
      dispatchPopstate({ count: 3 });
      dispatchPopstate({ count: 5 });

      await tick(app);

      // Should end up with the last value
      expect(app.s.count).toBe(5);
    });
  });

  describe('Anchor Interception', () => {
    /**
     * REQUIREMENT:
     * Click handlers on anchor tags should be able to prevent full page reloads.
     * This tests if @click handlers correctly respect .prevent modifier.
     */

    it('should prevent default navigation with .prevent modifier', async () => {
      document.body.innerHTML = `
        <div id="app">
          <a href="/about" id="nav-link" @click.prevent="handleNav('/about')">About</a>
          <span id="current" m-text="current"></span>
        </div>
      `;

      const app = new Reflex({
        current: 'home',
        handleNav(path) {
          this.current = path.replace('/', '');
          window.history.pushState({}, '', path);
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const link = document.getElementById('nav-link');
      const event = dispatchClick(link);
      await tick(app);

      // Default should be prevented (no full page reload)
      expect(event.defaultPrevented).toBe(true);
      expect(app.s.current).toBe('about');
    });

    it('should allow normal navigation when .prevent is not used', async () => {
      document.body.innerHTML = `
        <div id="app">
          <a href="/external" id="external-link" @click="trackClick()">External</a>
        </div>
      `;

      let tracked = false;
      const app = new Reflex({
        trackClick() {
          tracked = true;
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const link = document.getElementById('external-link');
      const event = dispatchClick(link);
      await tick(app);

      // Handler should run
      expect(tracked).toBe(true);
      // But default should NOT be prevented
      expect(event.defaultPrevented).toBe(false);
    });

    it('should handle dynamic href binding with navigation', async () => {
      document.body.innerHTML = `
        <div id="app">
          <a :href="targetUrl" id="dynamic-link" @click.prevent="navigate()">Go</a>
          <span id="nav-target" m-text="navigatedTo"></span>
        </div>
      `;

      const app = new Reflex({
        targetUrl: '/products',
        navigatedTo: '',
        navigate() {
          this.navigatedTo = this.targetUrl;
          window.history.pushState({}, '', this.targetUrl);
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const link = document.getElementById('dynamic-link');
      expect(link.getAttribute('href')).toBe('/products');

      // Change the target URL
      app.s.targetUrl = '/services';
      await tick(app);

      expect(link.getAttribute('href')).toBe('/services');

      // Click the link
      dispatchClick(link);
      await tick(app);

      expect(app.s.navigatedTo).toBe('/services');
    });

    it('should handle navigation with keyboard (Enter key)', async () => {
      document.body.innerHTML = `
        <div id="app">
          <a href="/page" id="keyboard-link" @click.prevent="go()" @keydown.enter.prevent="go()">Link</a>
          <span id="result" m-text="visited"></span>
        </div>
      `;

      const app = new Reflex({
        visited: false,
        go() {
          this.visited = true;
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const link = document.getElementById('keyboard-link');

      // Simulate Enter key
      const keyEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      });
      link.dispatchEvent(keyEvent);
      await tick(app);

      expect(app.s.visited).toBe(true);
    });

    it('should handle click with modifier keys (Ctrl/Cmd+click for new tab)', async () => {
      document.body.innerHTML = `
        <div id="app">
          <a href="/page" id="mod-link" @click="handleClick($event)">Link</a>
        </div>
      `;

      let shouldOpenNewTab = false;
      let regularClick = false;

      const app = new Reflex({
        handleClick(e) {
          // Standard pattern: allow Ctrl/Cmd+click to open in new tab
          if (e.ctrlKey || e.metaKey) {
            shouldOpenNewTab = true;
            // Don't prevent default - let browser open new tab
          } else {
            regularClick = true;
            e.preventDefault();
          }
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const link = document.getElementById('mod-link');

      // Regular click
      dispatchClick(link);
      await tick(app);
      expect(regularClick).toBe(true);

      // Ctrl+click
      regularClick = false;
      dispatchClick(link, { ctrlKey: true });
      await tick(app);
      expect(shouldOpenNewTab).toBe(true);
    });

    it('should handle programmatic navigation updates', async () => {
      document.body.innerHTML = `
        <div id="app">
          <nav>
            <a href="/" :class="route === 'home' ? 'active' : ''" @click.prevent="navigate('home')">Home</a>
            <a href="/about" :class="route === 'about' ? 'active' : ''" @click.prevent="navigate('about')">About</a>
          </nav>
          <main m-text="route"></main>
        </div>
      `;

      const app = new Reflex({
        route: 'home',
        navigate(to) {
          this.route = to;
          window.history.pushState({ route: to }, '', to === 'home' ? '/' : `/${to}`);
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const links = document.querySelectorAll('a');
      expect(links[0].className).toBe('active');
      expect(links[1].className).toBe('');

      // Navigate to about
      dispatchClick(links[1]);
      await tick(app);

      expect(app.s.route).toBe('about');
      expect(links[0].className).toBe('');
      expect(links[1].className).toBe('active');
    });
  });

  describe('Hash-Based Routing', () => {
    it('should react to hashchange events', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span id="hash-display" m-text="currentHash"></span>
        </div>
      `;

      const app = new Reflex({ currentHash: '' });

      window.addEventListener('hashchange', () => {
        app.s.currentHash = window.location.hash;
      });

      app.mount(document.getElementById('app'));
      await tick(app);

      // Simulate hash change
      const hashEvent = new HashChangeEvent('hashchange', {
        oldURL: window.location.href,
        newURL: window.location.href + '#section1'
      });

      // Update location.hash mock
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          hash: '#section1'
        },
        writable: true
      });

      window.dispatchEvent(hashEvent);
      await tick(app);

      expect(app.s.currentHash).toBe('#section1');
    });
  });

  describe('Route Parameters', () => {
    it('should support dynamic route matching', async () => {
      document.body.innerHTML = `
        <div id="app">
          <div m-if="routeParams.userId" id="user-view">
            User ID: <span id="user-id" m-text="routeParams.userId"></span>
          </div>
        </div>
      `;

      const app = new Reflex({
        routeParams: { userId: null }
      });

      // Simple route matcher
      const matchRoute = (pattern, path) => {
        const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
        const match = path.match(regex);
        return match ? match.groups : null;
      };

      // Set up routing
      const handleRoute = (path) => {
        const userMatch = matchRoute('/users/:userId', path);
        if (userMatch) {
          app.s.routeParams = userMatch;
        }
      };

      app.mount(document.getElementById('app'));
      await tick(app);

      expect(document.getElementById('user-view')).toBeNull();

      // Navigate to user page
      handleRoute('/users/123');
      await tick(app);

      expect(document.getElementById('user-view')).toBeTruthy();
      expect(document.getElementById('user-id').textContent).toBe('123');

      // Navigate to different user
      handleRoute('/users/456');
      await tick(app);

      expect(document.getElementById('user-id').textContent).toBe('456');
    });
  });

  describe('Navigation Guards', () => {
    it('should support beforeNavigate pattern', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span id="current-route" m-text="currentRoute"></span>
          <a href="/protected" @click.prevent="guardedNavigate('/protected')">Protected</a>
        </div>
      `;

      let navigationBlocked = false;

      const app = new Reflex({
        currentRoute: 'home',
        isAuthenticated: false,
        guardedNavigate(to) {
          // Navigation guard pattern
          if (to === '/protected' && !this.isAuthenticated) {
            navigationBlocked = true;
            return; // Block navigation
          }
          this.currentRoute = to;
          window.history.pushState({}, '', to);
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      const link = document.querySelector('a');
      dispatchClick(link);
      await tick(app);

      // Navigation should be blocked
      expect(navigationBlocked).toBe(true);
      expect(app.s.currentRoute).toBe('home');

      // Authenticate and try again
      app.s.isAuthenticated = true;
      navigationBlocked = false;
      dispatchClick(link);
      await tick(app);

      expect(navigationBlocked).toBe(false);
      expect(app.s.currentRoute).toBe('/protected');
    });

    it('should handle async navigation guards', async () => {
      document.body.innerHTML = `
        <div id="app">
          <span id="route" m-text="route"></span>
          <span id="loading" m-if="loading">Loading...</span>
        </div>
      `;

      const app = new Reflex({
        route: 'home',
        loading: false,
        async navigateTo(to) {
          this.loading = true;

          // Simulate async permission check
          await new Promise(r => setTimeout(r, 10));

          this.loading = false;
          this.route = to;
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      expect(app.s.route).toBe('home');

      // Start async navigation
      const navPromise = app.s.navigateTo('dashboard');
      await tick(app);

      // Should show loading state
      expect(app.s.loading).toBe(true);

      // Wait for navigation to complete
      await navPromise;
      await tick(app);

      expect(app.s.loading).toBe(false);
      expect(app.s.route).toBe('dashboard');
    });
  });

  describe('Scroll Restoration', () => {
    it('should support scroll position tracking', async () => {
      document.body.innerHTML = `
        <div id="app" style="height: 2000px;">
          <div id="scroll-indicator" m-text="scrollY"></div>
        </div>
      `;

      const app = new Reflex({
        scrollY: 0,
        saveScrollPosition() {
          this.scrollY = window.scrollY || document.documentElement.scrollTop;
        },
        restoreScrollPosition(y) {
          window.scrollTo(0, y);
          this.scrollY = y;
        }
      });
      app.mount(document.getElementById('app'));
      await tick(app);

      // Simulate scroll
      app.s.scrollY = 500;
      await tick(app);

      expect(document.getElementById('scroll-indicator').textContent).toBe('500');

      // Include scroll position in navigation state
      window.history.pushState({ scrollY: 500, route: 'page1' }, '', '/page1');

      // Navigate to new page
      app.s.scrollY = 0;
      window.history.pushState({ scrollY: 0, route: 'page2' }, '', '/page2');

      // Simulate back button with scroll restoration
      dispatchPopstate({ scrollY: 500, route: 'page1' });
      app.s.scrollY = 500;
      await tick(app);

      expect(document.getElementById('scroll-indicator').textContent).toBe('500');
    });
  });
});
