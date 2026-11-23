'use strict';

const form = document.getElementById('shorten-form');
const urlInput = document.getElementById('url');
const expiryInput = document.getElementById('expiresAt');
const submit = document.getElementById('submit');
const errorBox = document.getElementById('error');
const result = document.getElementById('result');
const shortUrl = document.getElementById('short-url');
const copy = document.getElementById('copy');
const expiryNote = document.getElementById('expiry-note');

let copyTimer = 0;

function showError(message, field) {
  result.hidden = true;
  errorBox.textContent = message;
  urlInput.removeAttribute('aria-invalid');
  expiryInput.removeAttribute('aria-invalid');
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  } else {
    errorBox.setAttribute('tabindex', '-1');
    errorBox.focus();
  }
}

function waitText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1) {
    return 'a little while';
  }
  if (seconds < 90) {
    return seconds + ' seconds';
  }
  return Math.ceil(seconds / 60) + ' minutes';
}

function messageFor(status, code, retryAfter) {
  if (code === 'invalid_url') {
    return 'That address is not allowed. Use an http or https link of up to 2048 characters, without a username or password, that does not point back at this service or at a private or loopback address.';
  }
  if (code === 'invalid_expiry') {
    return 'The expiry date must be in the future and within 10 years.';
  }
  if (status === 429) {
    return (
      'Too many requests. Please try again in ' +
      waitText(Number(retryAfter)) +
      '.'
    );
  }
  if (status === 413 || status === 415) {
    return 'The request could not be processed. Please check the address and try again.';
  }
  return 'Something went wrong on our side. Please try again in a moment.';
}

function fieldFor(code) {
  if (code === 'invalid_url') {
    return urlInput;
  }
  if (code === 'invalid_expiry') {
    return expiryInput;
  }
  return null;
}

function clientCheck(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a full web address, starting with http:// or https://.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http and https links can be shortened.';
  }
  return '';
}

async function onSubmit(event) {
  event.preventDefault();
  const url = urlInput.value.trim();
  urlInput.value = url;
  errorBox.textContent = '';

  if (url === '' || url.length > 2048 || clientCheck(url) !== '') {
    showError(
      clientCheck(url) || 'Enter a web address of up to 2048 characters.',
      urlInput,
    );
    return;
  }

  const body = { url };
  if (expiryInput.value !== '') {
    body.expiresAt = expiryInput.value;
  }

  submit.disabled = true;
  submit.setAttribute('aria-busy', 'true');
  submit.textContent = 'Shortening…';

  try {
    const res = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (
      res.status === 201 &&
      data &&
      typeof data.shortUrl === 'string' &&
      /^https?:\/\//.test(data.shortUrl)
    ) {
      showResult(data);
    } else {
      const code = data && data.error && data.error.code;
      showError(
        messageFor(res.status, code, res.headers.get('Retry-After')),
        fieldFor(code),
      );
    }
  } catch {
    showError(
      'Could not reach the server. Check your connection and try again.',
      null,
    );
  } finally {
    submit.disabled = false;
    submit.removeAttribute('aria-busy');
    submit.textContent = 'Shorten';
  }
}

function showResult(data) {
  urlInput.removeAttribute('aria-invalid');
  expiryInput.removeAttribute('aria-invalid');
  shortUrl.href = data.shortUrl;
  shortUrl.textContent = data.shortUrl;
  expiryNote.textContent = '';
  if (data.expiresAt) {
    expiryNote.textContent =
      'Expires ' + new Date(data.expiresAt).toUTCString() + '.';
  }
  clearTimeout(copyTimer);
  copy.textContent = 'Copy';
  result.hidden = false;
  shortUrl.focus();
}

function copyDone(text) {
  copy.textContent = text;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copy.textContent = 'Copy';
  }, 2500);
}

async function onCopy() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(shortUrl.href);
      copyDone('Copied');
      return;
    } catch {
      // fall through to manual selection
    }
  }
  const range = document.createRange();
  range.selectNodeContents(shortUrl);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  copyDone('Press Ctrl+C');
}

const tomorrow = new Date(Date.now() + 86400000);
expiryInput.min = tomorrow.toISOString().slice(0, 10);
form.addEventListener('submit', onSubmit);
copy.addEventListener('click', onCopy);
