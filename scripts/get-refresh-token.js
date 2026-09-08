'use strict';

/**
 * One-time helper: obtain a Google OAuth refresh token for your own account.
 *
 * Usage:
 *   1. Create an OAuth Client ID of type "Desktop app" in Google Cloud Console
 *      (see README). Copy the client id + secret into .env first.
 *   2. Run:  npm run get-token
 *   3. A browser opens → sign in with the Google account that owns the Drive
 *      folder → click Allow.
 *   4. Copy the printed refresh token into GOOGLE_REFRESH_TOKEN in .env.
 *
 * Zero-dependency: uses only Node's built-in http + fetch (Node 18+).
 */

const http = require('http');
const { URL } = require('url');

// Load .env if present (dotenv is a project dependency).
try { require('dotenv').config(); } catch (e) { /* no .env — fine */ }

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SCOPE = process.env.GOOGLE_DRIVE_SCOPE || 'https://www.googleapis.com/auth/drive';
const PORT = 3781;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;

function fail(msg) {
  console.error('\n❌ ' + msg);
  console.error(
    '   Make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in .env\n' +
    '   (create an OAuth client of type "Desktop app" in Google Cloud Console).'
  );
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) fail('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');

function openBrowser(url) {
  const { exec } = require('child_process');
  let cmd;
  if (process.platform === 'darwin') cmd = `open "${url}"`;
  else if (process.platform === 'win32') cmd = `start "" "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, html) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };

  if (url.pathname === '/oauth2callback') {
    const err = url.searchParams.get('error');
    if (err) {
      send(400, '<h3>Authorization failed:</h3><p>' + err + '</p><p>Close this tab and run the command again.</p>');
      server.close();
      process.exit(1);
    }
    const code = url.searchParams.get('code');
    if (!code) {
      send(400, '<h3>No authorization code received.</h3>');
      server.close();
      process.exit(1);
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT,
        }).toString(),
      });
      const json = await tokenRes.json();
      if (!tokenRes.ok || !json.refresh_token) {
        send(500, '<h3>Token exchange failed:</h3><pre>' + JSON.stringify(json, null, 2) + '</pre>');
        server.close();
        process.exit(1);
      }
      const html =
        '<h3 style="color:#0a7d33">✅ Success!</h3>' +
        '<p>Copy the refresh token below and paste it into <code>GOOGLE_REFRESH_TOKEN</code> in your .env file.</p>' +
        '<pre style="white-space:pre-wrap;word-break:break-all;background:#f5f5f5;padding:12px;border-radius:8px">' +
        json.refresh_token + '</pre>' +
        '<p><i>(It is also printed in the terminal where you ran this command.)</i></p>';
      send(200, html);
      console.log('\n──────────────────────────────────────────────────────────────');
      console.log('✅ Authorization successful! Your refresh token:\n');
      console.log(json.refresh_token);
      console.log('\n──────────────────────────────────────────────────────────────');
      console.log('Add this value to your .env as:  GOOGLE_REFRESH_TOKEN=...');
      server.close(() => process.exit(0));
    } catch (e) {
      send(500, '<h3>Network error during token exchange:</h3><pre>' + e.message + '</pre>');
      server.close();
      process.exit(1);
    }
    return;
  }

  if (url.pathname === '/') {
    send(
      200,
      '<h3>Waiting for Google…</h3><p>If the browser did not open, visit the link printed in the terminal.</p>'
    );
    return;
  }

  send(404, 'Not found');
});

server.listen(PORT, () => {
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
  console.log('\n1. Open this URL in your browser (auto-opening now…):\n');
  console.log(authUrl);
  console.log('\n2. Sign in with the Google account that owns the tour folder and click Allow.');
  console.log(`3. Waiting for the redirect to http://localhost:${PORT}/oauth2callback …\n`);
  openBrowser(authUrl);
});
