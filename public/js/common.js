'use strict';

/* Small shared helpers used by all pages. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function toast(message, { bad = false, ms = 3500 } = {}) {
  const root = $('#toastRoot');
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/** fetch + JSON with error normalization. Throws {status, code, message}. */
async function api(path, { method = 'GET', body, bearer, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (bearer) opts.headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    const err = new Error('NETWORK');
    err.status = 0;
    err.code = 'NETWORK';
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no json body */ }
  if (!res.ok) {
    const err = new Error(String((data && data.error) || res.status));
    err.status = res.status;
    err.code = (data && data.error) || 'HTTP_' + res.status;
    throw err;
  }
  return data;
}
