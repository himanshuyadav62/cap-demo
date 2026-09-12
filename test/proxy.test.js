const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { gzipSync } = require('node:zlib')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')

test('executeHttpRequest preserves a non-OK response as a raw stream', async () => {
  const body = gzipSync(Buffer.from('{\n  "error": "rejected"\n}\n'))
  const upstream = http.createServer((req, res) => {
    res.writeHead(418, 'Destination Error', {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': body.length,
      'x-upstream-header': 'preserved'
    })
    res.end(body)
  })

  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')

  try {
    const { port } = upstream.address()
    const response = await executeHttpRequest(
      { url: `http://127.0.0.1:${port}` },
      {
        method: 'GET',
        url: '/error',
        responseType: 'stream',
        decompress: false,
        validateStatus: () => true,
        timeout: 1000
      },
      { fetchCsrfToken: false }
    )
    const chunks = []
    response.data.on('data', chunk => chunks.push(chunk))
    await once(response.data, 'end')

    assert.equal(response.status, 418)
    assert.equal(response.statusText, 'Destination Error')
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.equal(response.headers['content-length'], String(body.length))
    assert.equal(response.headers['x-upstream-header'], 'preserved')
    assert.deepEqual(Buffer.concat(chunks), body)
  } finally {
    upstream.close()
    await once(upstream, 'close')
  }
})

test('executeHttpRequest fetches a CSRF token and forwards its session cookie', async () => {
  let modificationHeaders
  const upstream = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'x-csrf-token': 'csrf-token',
        'set-cookie': ['SAP_SESSION=csrf-session; Path=/; HttpOnly']
      })
      return res.end()
    }

    modificationHeaders = req.headers
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end('{}')
  })

  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')

  try {
    const { port } = upstream.address()
    const response = await executeHttpRequest(
      { url: `http://127.0.0.1:${port}` },
      {
        method: 'POST',
        url: '/changes',
        data: Buffer.from('{}'),
        headers: { 'content-type': 'application/json' },
        responseType: 'stream',
        validateStatus: () => true
      },
      { fetchCsrfToken: true }
    )
    response.data.resume()
    await once(response.data, 'end')

    assert.equal(response.status, 201)
    assert.equal(modificationHeaders['x-csrf-token'], 'csrf-token')
    assert.equal(modificationHeaders.cookie, 'SAP_SESSION=csrf-session')
  } finally {
    upstream.close()
    await once(upstream, 'close')
  }
})
