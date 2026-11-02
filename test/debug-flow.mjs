// Debug: run the proxy's protocol modules directly and print every upstream frame.
import { createVisitor, connectVisitor, ask } from '../src/chaoxing.mjs';

const question = process.argv[2] ?? '图书馆开放时间是什么时候？';
const visitor = await createVisitor();
console.log('visitor', visitor);
console.log('connect', await connectVisitor(visitor));
for await (const event of ask(visitor, question)) {
  console.log(JSON.stringify(event).slice(0, 400));
}
