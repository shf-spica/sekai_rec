const fs = require('fs');
const js = fs.readFileSync('app.js', 'utf8');
console.log(js.split('async function processImages() {')[1].split('}')[0]);
