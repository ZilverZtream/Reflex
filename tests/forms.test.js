/**
 * Form & File Tests
 *
 * "Reality is the Spec." These tests handle the messy reality of HTML Forms.
 *
 * Tests:
 * - File input binding
 * - FormData integration
 * - HTML5 validation
 *
 * If these tests fail, Reflex needs to handle forms correctly.
 * DO NOT modify tests to pass on broken behavior. Fix the framework.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reflex } from '../src/index.ts';

// Helper to dispatch input events
function dispatchInput(el, value) {
  if (el.type !== 'file') {
    el.value = value;
  }
  const event = new Event('input', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

// Helper to dispatch change events
function dispatchChange(el) {
  const event = new Event('change', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

// Helper to dispatch submit events
function dispatchSubmit(form) {
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

// Helper to wait for DOM operations
async function tick(app, times = 2) {
  for (let i = 0; i < times; i++) {
    await app.nextTick();
  }
}

// Create a mock FileList-like object
function createMockFileList(files) {
  const fileList = {
    length: files.length,
    item: (index) => files[index] || null,
    [Symbol.iterator]: function* () {
      for (let i = 0; i < files.length; i++) {
        yield files[i];
      }
    }
  };
  for (let i = 0; i < files.length; i++) {
    fileList[i] = files[i];
  }
  return fileList;
}

// Create a mock File object
function createMockFile(name, content = '', type = 'text/plain') {
  const blob = new Blob([content], { type });
  return new File([blob], name, { type });
}

describe('Form & File Handling', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('File Input Binding', () => {
    /**
     * CRITICAL REQUIREMENT:
     * Many frameworks crash because they try to read .value on file inputs,
     * which throws a security error or returns a fake path string (C:\fakepath\...).
     *
     * Reflex must:
     * 1. Not crash when handling file inputs
     * 2. Provide access to the FileList object, not a string
     */

    it('should not crash when binding to file input', async () => {
      document.body.innerHTML = `
        <input type="file" id="file-input" m-model="selectedFile">
      `;

      // This should not throw
      const app = new Reflex({ selectedFile: null });
      await tick(app);

      const input = document.getElementById('file-input');
      expect(input).toBeTruthy();
    });

    it('should handle file input change events without crashing', async () => {
      document.body.innerHTML = `
        <input type="file" id="file-input" @change="handleFile($event)">
      `;

      let receivedEvent = null;
      let filesReceived = null;

      const app = new Reflex({
        handleFile(e) {
          receivedEvent = e;
          filesReceived = e.target.files;
        }
      });
      await tick(app);

      const input = document.getElementById('file-input');

      // Create a mock file and dispatch change
      const mockFile = createMockFile('test.txt', 'Hello World');
      const mockFileList = createMockFileList([mockFile]);

      // Set files via Object.defineProperty (simulating browser behavior)
      Object.defineProperty(input, 'files', {
        value: mockFileList,
        writable: false
      });

      dispatchChange(input);
      await tick(app);

      expect(receivedEvent).toBeTruthy();
      expect(filesReceived).toBeTruthy();
      expect(filesReceived.length).toBe(1);
      expect(filesReceived[0].name).toBe('test.txt');
    });

    it('should provide FileList object not string in handler', async () => {
      document.body.innerHTML = `
        <input type="file" id="file-input" @change="files = $event.target.files">
      `;

      const app = new Reflex({ files: null });
      await tick(app);

      const input = document.getElementById('file-input');
      const mockFile = createMockFile('document.pdf', 'PDF content', 'application/pdf');
      const mockFileList = createMockFileList([mockFile]);

      Object.defineProperty(input, 'files', {
        value: mockFileList,
        writable: false
      });

      dispatchChange(input);
      await tick(app);

      // Should be FileList (or array-like), NOT a string
      expect(typeof app.s.files).not.toBe('string');
      expect(app.s.files.length).toBe(1);
      expect(app.s.files[0]).toBeInstanceOf(File);
    });

    it('should handle multiple file selection', async () => {
      document.body.innerHTML = `
        <input type="file" id="multi-file" multiple @change="handleFiles($event)">
        <div id="count" m-text="fileCount"></div>
      `;

      const app = new Reflex({
        fileCount: 0,
        handleFiles(e) {
          this.fileCount = e.target.files.length;
        }
      });
      await tick(app);

      const input = document.getElementById('multi-file');
      const files = [
        createMockFile('file1.txt'),
        createMockFile('file2.txt'),
        createMockFile('file3.txt')
      ];
      const mockFileList = createMockFileList(files);

      Object.defineProperty(input, 'files', {
        value: mockFileList,
        writable: false
      });

      dispatchChange(input);
      await tick(app);

      expect(app.s.fileCount).toBe(3);
      expect(document.getElementById('count').textContent).toBe('3');
    });

    it('should not try to set value on file input (security restriction)', async () => {
      // Attempting to set .value on a file input throws a security error
      // Reflex must not attempt this

      document.body.innerHTML = `
        <input type="file" id="file-input" m-model="file">
        <button @click="clearFile()">Clear</button>
      `;

      const app = new Reflex({
        file: null,
        clearFile() {
          // This pattern should not crash Reflex
          this.file = null;
        }
      });
      await tick(app);

      // Should not throw during render or state update
      app.s.file = null;
      await tick(app);

      expect(document.getElementById('file-input')).toBeTruthy();
    });

    it('should handle file input with accept attribute', async () => {
      document.body.innerHTML = `
        <input type="file" id="image-input" accept="image/*" @change="handleImage($event)">
      `;

      let receivedFile = null;
      const app = new Reflex({
        handleImage(e) {
          receivedFile = e.target.files[0];
        }
      });
      await tick(app);

      const input = document.getElementById('image-input');
      const imageFile = createMockFile('photo.jpg', 'JPEG data', 'image/jpeg');

      Object.defineProperty(input, 'files', {
        value: createMockFileList([imageFile]),
        writable: false
      });

      dispatchChange(input);
      await tick(app);

      expect(receivedFile).toBeTruthy();
      expect(receivedFile.type).toBe('image/jpeg');
    });
  });

  describe('FormData Integration', () => {
    /**
     * CRITICAL REQUIREMENT:
     * When FormData is constructed from a form, it must contain the user's input.
     * This verifies that Reflex updates the actual DOM value properties,
     * not just its internal state.
     */

    it('should update actual DOM input values for FormData', async () => {
      document.body.innerHTML = `
        <form id="test-form">
          <input type="text" name="username" m-model="username">
          <input type="email" name="email" m-model="email">
        </form>
      `;

      const app = new Reflex({
        username: 'john_doe',
        email: 'john@example.com'
      });
      await tick(app);

      const form = document.getElementById('test-form');
      const formData = new FormData(form);

      expect(formData.get('username')).toBe('john_doe');
      expect(formData.get('email')).toBe('john@example.com');
    });

    it('should include updated values in FormData after state changes', async () => {
      document.body.innerHTML = `
        <form id="test-form">
          <input type="text" name="name" m-model="name">
        </form>
      `;

      const app = new Reflex({ name: 'Initial' });
      await tick(app);

      // Update state
      app.s.name = 'Updated Value';
      await tick(app);

      const form = document.getElementById('test-form');
      const formData = new FormData(form);

      expect(formData.get('name')).toBe('Updated Value');
    });

    it('should handle checkbox values in FormData', async () => {
      document.body.innerHTML = `
        <form id="checkbox-form">
          <input type="checkbox" name="agree" value="yes" m-model="agreed">
          <input type="checkbox" name="newsletter" value="subscribe" m-model="newsletter">
        </form>
      `;

      const app = new Reflex({
        agreed: true,
        newsletter: false
      });
      await tick(app);

      const form = document.getElementById('checkbox-form');
      const formData = new FormData(form);

      // Checked checkbox should be in FormData
      expect(formData.get('agree')).toBe('yes');
      // Unchecked checkbox should not be in FormData
      expect(formData.get('newsletter')).toBeNull();
    });

    it('should handle select values in FormData', async () => {
      document.body.innerHTML = `
        <form id="select-form">
          <select name="country" m-model="country">
            <option value="us">United States</option>
            <option value="uk">United Kingdom</option>
            <option value="ca">Canada</option>
          </select>
        </form>
      `;

      const app = new Reflex({ country: 'uk' });
      await tick(app);

      const form = document.getElementById('select-form');
      const formData = new FormData(form);

      expect(formData.get('country')).toBe('uk');
    });

    it('should handle multi-select values in FormData', async () => {
      document.body.innerHTML = `
        <form id="multiselect-form">
          <select name="languages" multiple m-model="languages">
            <option value="js">JavaScript</option>
            <option value="py">Python</option>
            <option value="rs">Rust</option>
          </select>
        </form>
      `;

      const app = new Reflex({ languages: ['js', 'rs'] });
      await tick(app);

      const select = document.querySelector('select');

      // Verify m-model correctly sets the selected options
      expect(select.options[0].selected).toBe(true);  // js
      expect(select.options[1].selected).toBe(false); // py
      expect(select.options[2].selected).toBe(true);  // rs

      // Note: happy-dom has a bug where FormData.getAll() only returns the first
      // selected value for multi-selects. In real browsers, this works correctly.
      // We verify the DOM state is correct above, which is what Reflex controls.
      const form = document.getElementById('multiselect-form');
      const formData = new FormData(form);

      // At minimum, the first selected value should be present
      expect(formData.getAll('languages')).toContain('js');
    });

    it('should handle radio button values in FormData', async () => {
      document.body.innerHTML = `
        <form id="radio-form">
          <input type="radio" name="plan" value="free" m-model="plan">
          <input type="radio" name="plan" value="pro" m-model="plan">
          <input type="radio" name="plan" value="enterprise" m-model="plan">
        </form>
      `;

      const app = new Reflex({ plan: 'pro' });
      await tick(app);

      const form = document.getElementById('radio-form');
      const formData = new FormData(form);

      expect(formData.get('plan')).toBe('pro');
    });

    it('should handle textarea values in FormData', async () => {
      document.body.innerHTML = `
        <form id="textarea-form">
          <textarea name="message" m-model="message"></textarea>
        </form>
      `;

      const app = new Reflex({ message: 'Hello, World!\nThis is a test.' });
      await tick(app);

      const form = document.getElementById('textarea-form');
      const formData = new FormData(form);

      expect(formData.get('message')).toBe('Hello, World!\nThis is a test.');
    });

    it('should handle hidden input values in FormData', async () => {
      document.body.innerHTML = `
        <form id="hidden-form">
          <input type="hidden" name="token" :value="csrfToken">
        </form>
      `;

      const app = new Reflex({ csrfToken: 'abc123secret' });
      await tick(app);

      const form = document.getElementById('hidden-form');
      const formData = new FormData(form);

      expect(formData.get('token')).toBe('abc123secret');
    });

    it('should capture form submission with all bound values', async () => {
      document.body.innerHTML = `
        <form id="full-form" @submit.prevent="handleSubmit($event)">
          <input type="text" name="name" m-model="formData.name">
          <input type="email" name="email" m-model="formData.email">
          <select name="role" m-model="formData.role">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit">Submit</button>
        </form>
      `;

      let submittedData = null;

      const app = new Reflex({
        formData: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          role: 'admin'
        },
        handleSubmit(e) {
          submittedData = new FormData(e.target);
        }
      });
      await tick(app);

      const form = document.getElementById('full-form');
      dispatchSubmit(form);
      await tick(app);

      expect(submittedData).toBeTruthy();
      expect(submittedData.get('name')).toBe('Jane Doe');
      expect(submittedData.get('email')).toBe('jane@example.com');
      expect(submittedData.get('role')).toBe('admin');
    });
  });

  describe('HTML5 Validation', () => {
    /**
     * CRITICAL REQUIREMENT:
     * Reflex must not suppress native HTML5 validation states.
     * Setting state to invalid values should make form.checkValidity() return false.
     */

    it('should respect required attribute validation', async () => {
      document.body.innerHTML = `
        <form id="validation-form">
          <input type="text" name="required-field" required m-model="text">
        </form>
      `;

      const app = new Reflex({ text: '' });
      await tick(app);

      const form = document.getElementById('validation-form');
      const input = document.querySelector('input');

      // Empty required field should be invalid
      expect(input.validity.valueMissing).toBe(true);
      expect(form.checkValidity()).toBe(false);

      // Fill in the field
      app.s.text = 'Valid input';
      await tick(app);

      expect(input.validity.valueMissing).toBe(false);
      expect(form.checkValidity()).toBe(true);
    });

    it('should respect email validation', async () => {
      document.body.innerHTML = `
        <form id="email-form">
          <input type="email" name="email" m-model="email">
        </form>
      `;

      const app = new Reflex({ email: 'invalid-email' });
      await tick(app);

      const form = document.getElementById('email-form');
      const input = document.querySelector('input');

      expect(input.validity.typeMismatch).toBe(true);
      expect(form.checkValidity()).toBe(false);

      // Fix the email
      app.s.email = 'valid@email.com';
      await tick(app);

      expect(input.validity.typeMismatch).toBe(false);
      expect(form.checkValidity()).toBe(true);
    });

    it('should respect minlength/maxlength validation', async () => {
      document.body.innerHTML = `
        <form id="length-form">
          <input type="text" name="password" minlength="8" maxlength="20" m-model="password">
        </form>
      `;

      const app = new Reflex({ password: 'short' });
      await tick(app);

      const input = document.querySelector('input');

      // Too short - note: tooShort is only triggered on user interaction in some browsers
      // We test that the DOM value is correctly set
      expect(input.value).toBe('short');
      expect(input.minLength).toBe(8);

      // Valid length
      app.s.password = 'validpassword123';
      await tick(app);

      expect(input.value).toBe('validpassword123');
    });

    it('should respect pattern validation', async () => {
      document.body.innerHTML = `
        <form id="pattern-form">
          <input type="text" name="code" pattern="[A-Z]{3}[0-9]{3}" m-model="code">
        </form>
      `;

      const app = new Reflex({ code: 'invalid' });
      await tick(app);

      const form = document.getElementById('pattern-form');
      const input = document.querySelector('input');

      expect(input.validity.patternMismatch).toBe(true);
      expect(form.checkValidity()).toBe(false);

      // Fix to match pattern
      app.s.code = 'ABC123';
      await tick(app);

      expect(input.validity.patternMismatch).toBe(false);
      expect(form.checkValidity()).toBe(true);
    });

    it('should respect number input validation', async () => {
      document.body.innerHTML = `
        <form id="number-form">
          <input type="number" name="age" min="18" max="120" m-model="age">
        </form>
      `;

      const app = new Reflex({ age: 15 });
      await tick(app);

      const form = document.getElementById('number-form');
      const input = document.querySelector('input');

      expect(input.validity.rangeUnderflow).toBe(true);
      expect(form.checkValidity()).toBe(false);

      // Valid age
      app.s.age = 25;
      await tick(app);

      expect(input.validity.rangeUnderflow).toBe(false);
      expect(form.checkValidity()).toBe(true);
    });

    it('should update validation state reactively', async () => {
      document.body.innerHTML = `
        <form id="reactive-form">
          <input type="text" name="username" required m-model="username">
          <span id="error" m-if="!isValid">Required field</span>
        </form>
      `;

      const app = new Reflex({
        username: '',
        get isValid() {
          return this.username.length > 0;
        }
      });
      await tick(app);

      // Error should be visible
      expect(document.getElementById('error')).toBeTruthy();

      // Fill in username
      app.s.username = 'johndoe';
      await tick(app);

      // Error should be hidden
      expect(document.getElementById('error')).toBeNull();
    });

    it('should handle custom validity messages', async () => {
      document.body.innerHTML = `
        <form id="custom-form">
          <input type="text" id="custom-input" m-model="value" @input="validate($event)">
        </form>
      `;

      const app = new Reflex({
        value: '',
        validate(e) {
          const input = e.target;
          if (this.value === 'forbidden') {
            input.setCustomValidity('This value is not allowed');
          } else {
            input.setCustomValidity('');
          }
        }
      });
      await tick(app);

      const form = document.getElementById('custom-form');
      const input = document.getElementById('custom-input');

      // Initially valid
      expect(form.checkValidity()).toBe(true);

      // Set forbidden value
      dispatchInput(input, 'forbidden');
      app.s.value = 'forbidden';
      await tick(app);

      expect(input.validity.customError).toBe(true);
      expect(form.checkValidity()).toBe(false);
    });

    it('should not interfere with form.reportValidity()', async () => {
      document.body.innerHTML = `
        <form id="report-form">
          <input type="email" name="email" required m-model="email">
          <button type="button" @click="checkForm()">Validate</button>
        </form>
      `;

      let validityResult = null;

      const app = new Reflex({
        email: '',
        checkForm() {
          const form = document.getElementById('report-form');
          validityResult = form.checkValidity();
        }
      });
      await tick(app);

      // Trigger validation check via button
      const button = document.querySelector('button');
      button.click();
      await tick(app);

      expect(validityResult).toBe(false);

      // Fill in valid email
      app.s.email = 'test@example.com';
      await tick(app);

      button.click();
      await tick(app);

      expect(validityResult).toBe(true);
    });
  });

  describe('Form Reset', () => {
    it('should handle form reset event', async () => {
      document.body.innerHTML = `
        <form id="reset-form" @reset="handleReset()">
          <input type="text" name="name" m-model="name">
          <button type="reset">Reset</button>
        </form>
      `;

      let resetCalled = false;

      const app = new Reflex({
        name: 'John',
        handleReset() {
          resetCalled = true;
          this.name = '';
        }
      });
      await tick(app);

      expect(app.s.name).toBe('John');

      // Trigger reset
      const resetBtn = document.querySelector('button[type="reset"]');
      resetBtn.click();
      await tick(app);

      expect(resetCalled).toBe(true);
    });
  });

  describe('Input Types Edge Cases', () => {
    it('should handle date input', async () => {
      document.body.innerHTML = `
        <input type="date" m-model="date">
      `;

      const app = new Reflex({ date: '2024-01-15' });
      await tick(app);

      const input = document.querySelector('input');
      expect(input.value).toBe('2024-01-15');

      app.s.date = '2024-12-25';
      await tick(app);

      expect(input.value).toBe('2024-12-25');
    });

    it('should handle time input', async () => {
      document.body.innerHTML = `
        <input type="time" m-model="time">
      `;

      const app = new Reflex({ time: '14:30' });
      await tick(app);

      const input = document.querySelector('input');
      expect(input.value).toBe('14:30');
    });

    it('should handle color input', async () => {
      document.body.innerHTML = `
        <input type="color" m-model="color">
      `;

      const app = new Reflex({ color: '#ff5733' });
      await tick(app);

      const input = document.querySelector('input');
      expect(input.value).toBe('#ff5733');
    });

    it('should handle range input', async () => {
      document.body.innerHTML = `
        <input type="range" min="0" max="100" m-model="volume">
        <span id="display" m-text="volume"></span>
      `;

      const app = new Reflex({ volume: 50 });
      await tick(app);

      const input = document.querySelector('input');
      expect(input.value).toBe('50');

      app.s.volume = 75;
      await tick(app);

      expect(input.value).toBe('75');
      expect(document.getElementById('display').textContent).toBe('75');
    });
  });
});
