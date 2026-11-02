/**
 * Preload hook that keeps every TCP listener of the Playground process on the loopback interface.
 *
 * The Playground CLI listens on all interfaces unless told otherwise. This demo creates an administrator account
 * with a random password and runs deliberately open test routes, so the server must not be reachable from other
 * machines. Node loads this file first (NODE_OPTIONS=--require=...) and rewrites `listen(port, ...)` into
 * `listen(port, '127.0.0.1', ...)`. Nothing else about the server changes.
 */
'use strict';

const net = require('node:net');

const LOOPBACK = '127.0.0.1';
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listenOnLoopback(...args) {
  const first = args[0];
  if (typeof first === 'number' && typeof args[1] !== 'string') {
    // listen(port, callback) and listen(port): insert the host as the second argument.
    args.splice(1, 0, LOOPBACK);
  } else if (first && typeof first === 'object' && !('host' in first) && !('path' in first)) {
    // listen({ port }): add the host to the options object.
    args[0] = { ...first, host: LOOPBACK };
  }
  return originalListen.apply(this, args);
};
