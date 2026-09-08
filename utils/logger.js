'use strict';

/**
 * Tiny structured logger.
 * RULE: never pass secrets (passwords, PINs, tokens) to these functions.
 */

function ts() {
  return new Date().toISOString();
}

function out(level, msg, extra) {
  const line = `[${ts()}] ${level} ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

const logger = {
  info: (msg, extra) => out('INFO', msg, extra),
  warn: (msg, extra) => out('WARN', msg, extra),
  error: (msg, extra) => out('ERROR', msg, extra),
};

module.exports = logger;
