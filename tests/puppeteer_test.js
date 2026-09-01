const fs = require('fs');
const puppeteer = require('puppeteer-core');
const resolveBrowserPath = require('./browser_path');

module.exports = new Proxy(puppeteer, {
  get(target, property, receiver) {
    if (property !== 'launch') return Reflect.get(target, property, receiver);
    return (options = {}) => {
      const executablePath = options.executablePath && fs.existsSync(options.executablePath)
        ? options.executablePath
        : resolveBrowserPath();
      const args = [
        ...(options.args || []),
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
      ];
      return target.launch({ ...options, executablePath, args: [...new Set(args)] });
    };
  },
});
