// Models reach for different "finish" shapes; all of them must end the run instead of burning a step.
import { runAction } from '../src/sandbox.mjs';

const cases = [
  ['final_answer("直接调用")', '直接调用'],
  ['await callTool("final_answer", { answer: "当成工具调用" });', '当成工具调用'],
  ['await callTool("finish", "别名 finish");', '别名 finish'],
  ['const t = await callTool("now", {}); console.log(t.local); await final_answer("取到时间");', '取到时间'],
];

let failures = 0;
for (const [code, expected] of cases) {
  const result = await runAction(code, { tools: ['now'], timeoutMs: 10_000 });
  const ok = result.finalText === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${code.slice(0, 46)} -> ${JSON.stringify(result.finalText)}`);
}
console.log(`\n${cases.length - failures}/${cases.length} finish shapes handled`);
process.exit(failures ? 1 : 0);
