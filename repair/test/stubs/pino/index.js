// test stand-in: silent logger
const noop = () => {};
module.exports = () => ({ info: noop, warn: noop, error: noop, debug: noop, child() { return this; } });
