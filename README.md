# Reflex

A security-first reactive framework with unified protection across all rendering targets.

## The Trifecta: Three Engines, One Security Kernel

Reflex's unique architecture ensures that security is enforced **identically** whether you're rendering to the browser, a native app, or using AOT compilation. All three engines flow through the same Security Kernel:

```
                         ┌─────────────────────┐
                         │   SECURITY KERNEL   │
                         │     (sinks.ts)      │
                         │                     │
                         │  • URL Validation   │
                         │  • HTML Sanitization│
                         │  • CSS Protection   │
                         │  • Event Blocking   │
                         └─────────┬───────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
   │   WEB ENGINE    │   │   APP ENGINE    │   │ COMPILED ENGINE │
   │   (DOMRenderer) │   │ (VirtualRenderer)│   │    (AOT)       │
   │                 │   │                 │   │                 │
   │  Direct DOM     │   │  Virtual DOM    │   │  Pre-compiled   │
   │  Browser APIs   │   │  Native/SSR     │   │  Static output  │
   └─────────────────┘   └─────────────────┘   └─────────────────┘
```

**Why this matters:**
- A vulnerability patched in the kernel is fixed for ALL targets
- No "it works in dev but not in production" security gaps
- Native apps get the same protection as web apps
- AOT-compiled code inherits runtime security checks

## Security Kernel v6.0 ("Zero Trust")

### Architecture: ALLOWLIST Over BLOCKLIST

The v6.0 kernel fundamentally changed from blocking known-bad patterns to allowing only known-good patterns:

```typescript
// OLD (Blocklist - INSECURE):
// Block javascript: → misses vbscript:, file:, ms-settings:, etc.

// NEW (Allowlist - SECURE):
// Allow ONLY: http, https, mailto, tel, sms, ftp, relative URLs, data:image/*
// Everything else is blocked by default
```

### Sink Classification

The kernel classifies dangerous DOM sinks into 5 types:

| Type | Sinks | Protection |
|------|-------|------------|
| **1: URL** | href, src, action, formaction, poster, etc. | Protocol allowlist |
| **2: HTML** | innerHTML, outerHTML, srcdoc | SafeHTML required |
| **3: CSS** | style | Block expression(), @import, javascript: |
| **4: Event** | on* (onclick, on-click, onload, etc.) | Pattern-blocked |
| **5: Navigation** | target, formtarget, http-equiv | Tabnabbing protection |

### v6.0 Security Fixes

| Issue | Severity | Description | Fix |
|-------|----------|-------------|-----|
| #1 | Critical | Iframe Sandbox Escape | Removed `allow-same-origin` from default |
| #2 | High | Tabnabbing via `formtarget` | Added formtarget to noopener checks |
| #3 | High | Protocol Smuggling | Switched to ALLOWLIST architecture |
| #4 | High | CSS Exfiltration via `<link>` | Blocked `<link>` tag creation |
| #5 | Medium | Event Regex Issues | Fixed false positives/negatives |
| #6 | Medium | Unvalidated `<style>` | Added @import and pattern validation |

## How the Trifecta Works

### 1. Web Engine (DOMRenderer)

Direct browser DOM manipulation. Every `setAttribute`, `setProperty`, and `setInnerHTML` call passes through the Security Kernel:

```typescript
// In your template:
<a :href="userUrl">Click</a>

// DOMRenderer.setAttribute() calls:
if (!validateSink('href', userUrl)) {
  // Blocked - javascript:, vbscript:, file:, etc.
  return;
}
node.setAttribute('href', userUrl);
```

### 2. App Engine (VirtualRenderer)

Virtual DOM for native apps and SSR. Same kernel, different output:

```typescript
// VirtualRenderer uses identical validation:
if (!validateSink(prop, value)) {
  return; // Blocked
}
// Then writes to virtual node instead of real DOM
```

### 3. Compiled Engine (AOT)

Ahead-of-time compilation still uses the kernel at runtime:

```typescript
// Compiled output includes kernel calls:
const compiled = `
  if (!validateSink('href', ${expr})) return;
  el.setAttribute('href', ${expr});
`;
```

## The Iron Membrane

Beyond sink validation, Reflex wraps all user data in a security proxy:

```typescript
import { createMembrane } from 'reflex/core/symbols';

// User data is wrapped in protective proxy
const safeData = createMembrane(userData);

// Blocks:
// - Prototype pollution: __proto__, constructor, prototype
// - Unsafe method access: only whitelisted methods allowed
// - DOM escape: $el wrapped to block ownerDocument, parentNode, etc.
```

## Installation

```bash
npm install reflex
```

## Quick Start

```html
<div m-state="{ count: 0 }">
  <p>Count: {{ count }}</p>
  <button @click="count++">Increment</button>
</div>

<script type="module">
  import { Reflex } from 'reflex';
  Reflex.init();
</script>
```

## Security Best Practices

### User-Generated HTML

```typescript
import { SafeHTML } from 'reflex/core';

// Always sanitize - required for Type 2 sinks
const safe = SafeHTML.sanitize(userInput);
renderer.setInnerHTML(element, safe);
```

### User-Provided URLs

```typescript
// Automatically validated through the allowlist
// javascript:, vbscript:, file: etc. are silently blocked
<a :href="userUrl">Link</a>
```

### Custom Iframe Sandboxing

```typescript
// Default: sandbox="allow-scripts allow-forms" (secure)
<iframe :src="url"></iframe>

// If you NEED same-origin (rare, understand the risk):
<iframe :src="url" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
// WARNING: allow-scripts + allow-same-origin = sandbox escape vector
```

## API Reference

### validateSink

```typescript
import { validateSink, getSinkType, isSink } from 'reflex/core/sinks';

validateSink('href', 'https://example.com');  // true
validateSink('href', 'javascript:alert(1)');  // false
validateSink('href', 'vbscript:msgbox(1)');   // false (v6: allowlist)
validateSink('href', 'file:///etc/passwd');   // false (v6: allowlist)

getSinkType('href');      // 1 (URL)
getSinkType('innerHTML'); // 2 (HTML)
getSinkType('style');     // 3 (CSS)
```

### SafeHTML

```typescript
import { SafeHTML } from 'reflex/core';

SafeHTML.sanitize(html);           // Sanitize untrusted HTML
SafeHTML.unsafe(trustedHtml);      // Mark trusted content (no sanitization)
SafeHTML.isSafeHTML(value);        // Type check
SafeHTML.configureSanitizer(impl); // Set sanitizer (e.g., DOMPurify)
```

## Architecture

```
src/
├── core/
│   ├── sinks.ts       # THE SECURITY KERNEL - all engines use this
│   ├── symbols.ts     # Iron Membrane, safe URL patterns
│   ├── safe-html.ts   # SafeHTML wrapper for Type 2 sinks
│   └── reactive.ts    # Reactivity system
├── renderers/
│   ├── dom.ts         # WEB ENGINE - browser target
│   └── virtual.ts     # APP ENGINE - native/SSR target
└── compiler/          # COMPILED ENGINE - AOT target
```

## License

MIT

## Security Reporting

Report vulnerabilities to [security@example.com](mailto:security@example.com). Do not open public issues for security concerns.
