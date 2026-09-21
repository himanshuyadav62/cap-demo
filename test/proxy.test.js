const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { gzipSync } = require('node:zlib')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const forwardHeaders = require('../srv/forward-headers')
const proxyRedirects = require('../srv/proxy-redirects')

test('proxy credentials are not restored to a different origin or proxy', async () => {
  const request = {
    baseURL: 'http://virtual-backend:443',
    proxy: { host: 'connectivity-proxy', port: 20003, protocol: 'http' },
    headers: { 'Proxy-Authorization': 'Bearer connectivity-token' }
  }
  const configured = await proxyRedirects({ fn: async value => value })(request)
  for (const change of [
    { href: 'http://other-backend/service' },
    { href: 'https://virtual-backend:443/service' },
    { hostname: 'other-proxy' },
    { port: 20004 }
  ]) {
    const options = {
      href: 'http://virtual-backend:443/service/',
      hostname: 'connectivity-proxy', port: 20003, protocol: 'http:',
      headers: {}, ...change
    }
    assert.throws(() => configured.beforeRedirect(options), /On-premise redirect/)
    assert.equal(options.headers['Proxy-Authorization'], undefined)
  }
})

test('on-premise redirect retains proxy authentication on the second hop', async () => {
  const requests = []
  const proxy = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (!req.headers['proxy-authorization']) {
      res.writeHead(407)
      return res.end('Missing or empty header: proxy-authorization')
    }
    if (requests.length === 1) {
      res.writeHead(301, { location: '/service/0001/' })
      return res.end()
    }
    res.end('service document')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const response = await executeHttpRequest({
      url: 'http://virtual-backend:443',
      proxyType: 'OnPremise', authentication: 'BasicAuthentication',
      username: 'backend-user', password: 'test-password',
      cloudConnectorLocationId: 'BTP-CBB-CBT-NA-DEV',
      proxyConfiguration: {
        host: '127.0.0.1', port: proxy.address().port, protocol: 'http',
        headers: { 'Proxy-Authorization': 'Bearer connectivity-token' }
      }
    }, {
      method: 'GET', url: '/service/0001',
      middleware: [proxyRedirects],
      timeout: 2000, validateStatus: () => true
    }, { fetchCsrfToken: false })
    assert.equal(response.status, 200)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['proxy-authorization'], 'Bearer connectivity-token')
    assert.equal(requests[1].headers.authorization,
      `Basic ${Buffer.from('backend-user:test-password').toString('base64')}`)
    assert.equal(requests[1].headers['sap-connectivity-scc-location_id'], 'BTP-CBB-CBT-NA-DEV')
  } finally {
    proxy.close()
    await once(proxy, 'close')
  }
})

test('on-premise request keeps SDK proxy and Basic authentication despite incoming headers', async () => {
  let received
  const proxy = http.createServer((req, res) => {
    received = { url: req.url, headers: req.headers }
    res.writeHead(req.headers['proxy-authorization'] === 'Bearer connectivity-token' ? 200 : 407)
    res.end('response')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const headers = forwardHeaders({ headers: {
      'x-destination': 'CFIN_BLOOMBERG_DEST',
      authorization: 'Bearer caller-token',
      'proxy-authorization': '',
      'sap-connectivity-scc-location_id': 'wrong-location',
      'sap-connectivity-authentication': 'Bearer caller-token',
      host: 'application.example.com',
      connection: 'keep-alive, x-hop-header',
      'x-hop-header': 'remove-me',
      accept: 'application/json',
      'x-correlation-id': 'test-request'
    } })
    const response = await executeHttpRequest({
      url: 'http://virtual-backend:443',
      proxyType: 'OnPremise',
      authentication: 'BasicAuthentication',
      username: 'backend-user',
      password: 'test-password',
      cloudConnectorLocationId: 'BTP-CBB-CBT-NA-DEV',
      proxyConfiguration: {
        host: '127.0.0.1', port: proxy.address().port, protocol: 'http',
        headers: { 'Proxy-Authorization': 'Bearer connectivity-token' }
      }
    }, {
      method: 'GET', url: '/sap/opu/odata/test?$top=1', headers,
      timeout: 2000, validateStatus: () => true
    }, { fetchCsrfToken: false })
    assert.equal(response.status, 200)
    assert.equal(received.headers['proxy-authorization'], 'Bearer connectivity-token')
    assert.equal(received.headers.authorization,
      `Basic ${Buffer.from('backend-user:test-password').toString('base64')}`)
    assert.equal(received.headers['sap-connectivity-scc-location_id'], 'BTP-CBB-CBT-NA-DEV')
    assert.equal(received.headers.host, 'virtual-backend:443')
    assert.equal(received.url, 'http://virtual-backend:443/sap/opu/odata/test?$top=1')
    assert.equal(received.headers['x-destination'], undefined)
    assert.equal(received.headers['sap-connectivity-authentication'], undefined)
    assert.equal(received.headers['x-hop-header'], undefined)
    assert.equal(received.headers.accept, 'application/json')
    assert.equal(received.headers['x-correlation-id'], 'test-request')
  } finally {
    proxy.close()
    await once(proxy, 'close')
  }
})

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
