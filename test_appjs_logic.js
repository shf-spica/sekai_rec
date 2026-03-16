const fs = require('fs');

const appJs = fs.readFileSync('app.js', 'utf8');

const code = `
let consoleLogs = [];
const console = { log: (...args) => consoleLogs.push("LOG: " + args.join(' ')), warn: (...args) => consoleLogs.push("WARN: " + args.join(' ')), error: (...args) => consoleLogs.push("ERR: " + args.join(' ')) };

const document = {
  querySelector: (sel) => ({
    style: {},
    innerHTML: '',
    className: '',
    checked: true,
    addEventListener: () => {},
    dataset: {},
    textContent: ''
  }),
  querySelectorAll: () => []
};

const window = { Tesseract: { createWorker: async () => ({ loadLanguage: async()=>{}, initialize: async()=>{}, recognize: async() => ({data:{text:'a'}}), terminate: async()=>{} }) } };
const performance = { now: () => 0 };
const navigator = { clipboard: { writeText: async() => {} } };

class FileReader {
  readAsDataURL() { this.onload({target:{result:'data:image/empty'}}); }
}

${appJs}

state.files.push({ id: 1, file: { name: 'test.jpg' }, dataUrl: 'data' });

(async () => {
  consoleLogs.push("--- Before processImages ---");
  try {
    await processImages();
    consoleLogs.push("--- After processImages ---");
    consoleLogs.push("state.isProcessing: " + state.isProcessing);
    consoleLogs.push("state.results length: " + state.results.length);
  } catch (e) {
    consoleLogs.push("UNCAUGHT EXCEPTION: " + e.stack);
  }
  require('fs').writeFileSync('debug_output.txt', consoleLogs.join('\\n'));
})();
`;

fs.writeFileSync('sandbox.js', code);
