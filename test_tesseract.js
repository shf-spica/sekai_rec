const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');

const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
const window = dom.window;
const document = window.document;

window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
window.Tesseract = {
  createWorker: async () => ({
    loadLanguage: async () => {},
    initialize: async () => {},
    recognize: async () => ({ data: { text: 'Test' } }),
    terminate: async () => {}
  })
};

setTimeout(() => {
    try {
        const appJs = fs.readFileSync('app.js', 'utf8');
        window.eval(appJs);
        console.log("App.js evaluated.");

        // Simulate file upload
        const entry = { id: 1, file: { name: 'test.jpg' }, dataUrl: 'data:image/jpeg;base64,123' };
        window.state.files.push(entry);
        console.log("File added.");

        // Simulate click
        const btn = document.getElementById('ocr-btn');
        console.log("Button visible?", !!btn);
        btn.click();
        console.log("Click dispatched.");
    } catch (e) {
        console.error("Error:", e);
    }
}, 1000);
