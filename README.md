# Reflex

A security-first reactive framework for building web applications with defense-in-depth XSS protection.

## Security Architecture: The Trifecta Model

Reflex implements a unique "Trifecta" security model that provides defense-in-depth protection against XSS and related injection attacks. Security is enforced at three layers:

```
    +-------------------+
    |   Compile Time    |  <- Template validation, expression parsing
    +-------------------+
            |
            v
    +-------------------+
    |   Runtime Proxy   |  <- Iron Membrane, element sandboxing
    +-------------------+
            |
            v
    +-------------------+
    |   Sink Kernel     |  <- Final validation before DOM writes
    +-------------------+
```

### Security Kernel v6.0 ("Zero Trust")

The latest security kernel (v6.0) implements a Zero Trust architecture with the following key protections:

#### 1. URL Injection Protection (Type 1 Sinks)

**Architecture: ALLOWLIST (not blocklist)**

```typescript
// ALLOWED protocols:
// - http:, https: (web URLs)
// - mailto:, tel:, sms: (communication)
// - ftp:, ftps: (file transfer)
// - Relative URLs: /, ./, ../, #, ?
// - data:image/* (images only)

// BLOCKED (everything else):
// - javascript: (XSS)
// - vbscript: (legacy RCE)
// - file: (local file disclosure)
// - ms-settings:, git: (system interaction)
// - data:text/html (phishing)
```

**Why allowlist?** Blocklists require constant patching as new protocols emerge. The allowlist approach is "secure by default" - unknown protocols are blocked automatically.

#### 2. HTML Injection Protection (Type 2 Sinks)

Direct assignment to `innerHTML`, `outerHTML`, and `srcdoc` is blocked. All HTML content must go through the `SafeHTML` wrapper:

```typescript
import { SafeHTML } from 'reflex/core';

// User content - sanitized via DOMPurify
const safe = SafeHTML.sanitize(userInput);
renderer.setInnerHTML(element, safe);

// Trusted static content
const trusted = SafeHTML.unsafe('<div class="wrapper">Static</div>');
```

#### 3. CSS Injection Protection (Type 3 Sinks)

Blocks dangerous CSS patterns that enable code execution or data exfiltration:

- `expression()` - IE legacy JavaScript in CSS
- `javascript:` in `url()` - Script execution
- `@import` - External stylesheet loading (CSS exfiltration)
- `-moz-binding`, `behavior` - Legacy browser exploits

#### 4. Event Handler Protection (Type 4 Sinks)

Pattern-based blocking of all event handler attributes:

```typescript
// BLOCKED: onclick, onload, onerror, on-click (Web Components)
// ALLOWED: only, once, online (common words - no event handler suffix)
```

#### 5. Navigation Protection (Type 5 Sinks)

Prevents tabnabbing and redirect attacks:

- Auto-applies `rel="noopener noreferrer"` when `target="_blank"` is set
- Also protects `formtarget="_blank"` (HTML5 form target bypass)
- Validates `http-equiv` and `content` for meta refresh XSS

### Iframe Sandbox Security

Iframes automatically receive secure sandbox defaults:

```typescript
// When setting src on an iframe, Reflex auto-applies:
sandbox="allow-scripts allow-forms"
```

**Critical:** `allow-same-origin` is intentionally omitted because using it with `allow-scripts` allows sandbox escape. The iframe can access `parent.document`, remove its own sandbox attribute, and reload with full privileges.

### The Iron Membrane

Reflex wraps all user data in a security proxy ("Iron Membrane") that:

1. **Blocks prototype pollution**: `__proto__`, `constructor`, `prototype` access denied
2. **Controls method access**: Only safe methods (map, filter, etc.) are allowed
3. **Wraps DOM elements**: `$el` access is sandboxed - no access to `ownerDocument`, `parentNode`, etc.
4. **Validates style assignments**: CSS property writes are checked for dangerous patterns

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

## Security Audit Findings Addressed (v6.0)

| Issue | Severity | Description | Fix |
|-------|----------|-------------|-----|
| #1 | Critical | Iframe Sandbox Escape | Removed `allow-same-origin` from default sandbox |
| #2 | High | Reverse Tabnabbing via `formtarget` | Added `formtarget` to noopener checks |
| #3 | High | Protocol Smuggling (Blocklist) | Switched to ALLOWLIST architecture |
| #4 | High | CSS Exfiltration via `<link>` | Blocked `<link>` tag creation |
| #5 | Medium | Event Regex False Positives | Refined pattern to allow 'only', 'once' |
| #6 | Medium | Unvalidated `<style>` Content | Added `@import` and pattern validation |

## Security Best Practices

### For User-Generated Content

```typescript
import { SafeHTML } from 'reflex/core';

// Always sanitize user HTML
const userComment = SafeHTML.sanitize(rawUserInput);
renderer.setInnerHTML(commentDiv, userComment);
```

### For URLs from User Input

```typescript
// URLs are automatically validated through the allowlist
// If a user provides a javascript: URL, it will be silently blocked
<a :href="userProvidedUrl">Link</a>
```

### For Custom Iframe Sandboxing

```typescript
// If you need allow-same-origin (rare), set sandbox explicitly:
<iframe
  :src="trustedUrl"
  sandbox="allow-scripts allow-same-origin allow-forms"
></iframe>

// WARNING: allow-scripts + allow-same-origin = sandbox escape vector
// Only use this for content you fully trust
```

### Content Security Policy

Reflex is designed to work with strict CSP:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
```

## API Reference

### SafeHTML

```typescript
// Sanitize untrusted HTML (uses DOMPurify if configured)
SafeHTML.sanitize(html: string): SafeHTML

// Mark trusted static content as safe (NO sanitization)
SafeHTML.unsafe(html: string): SafeHTML

// Configure sanitizer (e.g., DOMPurify)
SafeHTML.configureSanitizer(sanitizer: ISanitizer): void

// Check if value is SafeHTML instance
SafeHTML.isSafeHTML(value: any): boolean
```

### Sink Validation

```typescript
import { validateSink, getSinkType, isSink } from 'reflex/core/sinks';

// Check if a property write is safe
validateSink('href', 'https://example.com'); // true
validateSink('href', 'javascript:alert(1)'); // false

// Get sink type (1=URL, 2=HTML, 3=CSS, 4=Event, 5=Navigation)
getSinkType('href'); // 1
getSinkType('innerHTML'); // 2

// Check if property is a sink
isSink('onclick'); // true (event handler pattern)
isSink('className'); // false
```

## Architecture

```
src/
├── core/
│   ├── sinks.ts       # Security Kernel - sink validation
│   ├── symbols.ts     # Iron Membrane - proxy sandbox
│   ├── safe-html.ts   # SafeHTML wrapper
│   └── reactive.ts    # Reactivity system
├── renderers/
│   ├── dom.ts         # DOM Renderer - web target
│   └── virtual.ts     # Virtual Renderer - SSR/Native
├── compiler/
│   └── ...            # AOT compilation
└── directives/
    └── ...            # Built-in directives (m-if, m-for, etc.)
```

## License

MIT

## Security Reporting

If you discover a security vulnerability, please report it via [security@example.com](mailto:security@example.com). Do not open public issues for security vulnerabilities.
