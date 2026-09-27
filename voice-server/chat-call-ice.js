'use strict';
const crypto = require('node:crypto');

function getChatCallIceConfig(env = process.env, userId = 0, now = Date.now()) {
  const list = value => String(value || '').split(/[\s,]+/).filter(Boolean);
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const urls = list(env.CALL_TURN_URL || env.RTC_TURN_URLS || env.TURN_URLS || env.TURN_URL)
    .filter(url => /^turns?:[^\s/@]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/i.test(url));
  let username = String(env.CALL_TURN_USERNAME || env.RTC_TURN_USERNAME || env.TURN_USERNAME || '').trim();
  let credential = String(env.CALL_TURN_CREDENTIAL || env.RTC_TURN_CREDENTIAL || env.TURN_CREDENTIAL || '').trim();
  const secret = env.CALL_TURN_SECRET;
  if (secret && urls.length) {
    username = `${Math.floor(now / 1000) + 86400}:${Number(userId) || 0}`;
    credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  }
  const relayConfigured = Boolean(urls.length && username && credential);
  if (relayConfigured) iceServers.push({ urls, username, credential });
  return { iceServers, relayConfigured };
}

module.exports = { getChatCallIceConfig };
