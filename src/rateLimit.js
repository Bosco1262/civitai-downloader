'use strict';

/**
 * A simple even-rate limiter (a degenerate token bucket: it guarantees at least
 * 1000/perSecond ms between two requests). Used for site API calls so that a burst of requests
 * does not trigger risk control.
 *
 * 简单的匀速限流器（令牌桶的退化形式：保证两次请求间隔 >= 1000/perSecond 毫秒）。
 * 用于站点 API 调用，避免短时间大量请求触发风控。
 */

const { sleep } = require('./util');

/**
 * @param {number} perSecond 每秒允许的请求数；<=0 表示不限速
 * @returns {{acquire: () => Promise<void>, enabled: boolean}}
 */
function createRateLimiter(perSecond) {
  const rate = Number(perSecond);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { acquire: async () => {}, enabled: false };
  }
  const interval = 1000 / rate;
  let nextAt = 0;
  let queue = Promise.resolve();

  return {
    enabled: true,
    acquire() {
      const run = queue.then(async () => {
        const now = Date.now();
        const wait = nextAt - now;
        if (wait > 0) await sleep(wait);
        nextAt = Math.max(Date.now(), nextAt) + interval;
      });
      // The queue itself must not be dragged down by a rejection.
      // 队列自身不能被拒绝拖垮。
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}

module.exports = { createRateLimiter };
