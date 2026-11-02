// Isolation guarantees of the action sandbox: filesystem, process and network escape attempts must fail,
// and a runaway loop must be killed without taking the parent down.
import { runAction } from '../src/sandbox.mjs';

const CASES = [
  {
    name: 'filesystem read is denied',
    code: `const fs = require('node:fs'); console.log(fs.readFileSync('C:/Windows/win.ini','utf8'));`,
    expect: /require is not defined|readFileSync|not defined/i,
  },
  {
    name: 'process object is unavailable',
    code: `console.log(typeof process); if (typeof process !== 'undefined') process.exit(1); await final_answer('process=' + typeof process);`,
    expectAny: true,
  },
  {
    name: 'dynamic import throws',
    code: `const fs = await import('node:fs'); console.log('imported');`,
    expect: /import|SyntaxError|Unexpected/i,
  },
  {
    name: 'Function constructor is blocked',
    code: `const f = new Function('return process'); console.log(f());`,
    expect: /blocked|not defined|EvalError|Code generation/i,
  },
  {
    name: 'infinite loop is killed',
    code: `while (true) { console.log('spin'); }`,
    timeoutMs: 3_000,
    expect: /超时|timeout|terminated/i,
  },
];

let failures = 0;
for (const testCase of CASES) {
  const result = await runAction(testCase.code, { tools: ['now'], timeoutMs: testCase.timeoutMs ?? 8_000 });
  const combined = `${result.error ?? ''}\n${result.logs.join('\n')}`;
  const passed = testCase.expectAny
    ? `${result.finalText ?? ''}|${result.logs.join('\n')}`.includes('process=undefined')
    : testCase.expect.test(combined);
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${testCase.name}`);
  if (!passed) {
    failures += 1;
    console.log('   got:', JSON.stringify(combined).slice(0, 300));
  }
}

// A normal action still works after all the hostile ones.
const ok = await runAction('const t = await callTool("now", {}); await final_answer("时间 " + t.local);', {
  tools: ['now'],
  timeoutMs: 8_000,
});
console.log(`${ok.finalText?.startsWith('时间') ? 'PASS' : 'FAIL'}  benign action still works after sandbox abuse`);
if (!ok.finalText?.startsWith('时间')) failures += 1;

console.log(`\n${failures === 0 ? 'sandbox isolation verified' : failures + ' sandbox check(s) failed'}`);
process.exit(failures ? 1 : 0);
