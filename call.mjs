// 小客户端：node call.mjs <tool> '<json args>' [timeoutMs]
const [tool, rawArgs, timeoutArg] = process.argv.slice(2)
const timeout = Number(timeoutArg || 120000)
const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: JSON.parse(rawArgs || '{}') } })
const started = Date.now()
const res = await fetch('http://127.0.0.1:18060/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeout) })
const data = await res.json()
const text = data.result?.content?.[0]?.text ?? JSON.stringify(data)
let parsed
try { parsed = JSON.parse(text) } catch { parsed = text }
const short = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
console.log(`[${tool}] ${((Date.now() - started) / 1000).toFixed(1)}s ${data.result?.isError ? 'ERROR' : 'OK'}`)
console.log(short.length > 1200 ? short.slice(0, 1200) + ' …' : short)
