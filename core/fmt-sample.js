// 样例格式化器:node fmt-sample.js <文件>
const fs = require('fs');
const eng = require('./engine.js');
const p = process.argv[2];
const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
const r = eng.process({ text, mode: 'format', funcList: eng.DEFAULT_FUNCS });
console.log('--- 诊断 (' + r.diagnostics.length + ') ---');
r.diagnostics.forEach(d => console.log('  ' + d.level + ' ' + d.rule + ' [' + d.line + ':' + d.col + '] ' + d.message));
console.log('--- 格式化 ---');
console.log(r.formatted);
console.log('--- 行数: ' + r.formatted.split('\n').length + ' ---');
