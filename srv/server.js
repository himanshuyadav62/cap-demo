const cds = require('@sap/cds')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const xsenv = require('@sap/xsenv')
const { pipeline } = require('node:stream')
const forwardHeaders = require('./forward-headers')
const proxyRedirects = require('./proxy-redirects')

const DEFAULT_DESTINATION =
  process.env.DEFAULT_DESTINATION || process.env.DESTINATION || ''

// Timeout for destination calls (ms). Default: 30 s. Set PROXY_TIMEOUT_MS to override.
const PROXY_TIMEOUT_MS = Number.parseInt(process.env.PROXY_TIMEOUT_MS || '30000', 10)

// Only the seed refresh token comes from env —
// clientid, clientsecret, and token URL are read from the XSUAA service binding
const REFRESH_TOKEN_SEED = process.env.REFRESH_TOKEN || ''

// In-memory token cache — updated after every successful token exchange
const tokenCache = {
  accessToken: null,
  accessTokenExpiresAt: 0,   // ms since epoch
  refreshToken: REFRESH_TOKEN_SEED,
  refreshTokenExpiresAt: 0   // 0 = unknown / treat as non-expiring
}

// Proactive refresh buffers
const ACCESS_TOKEN_BUFFER_MS  = 60  * 1000  //  60 s before access token expires
const REFRESH_TOKEN_BUFFER_MS = 5 * 60 * 1000  //   5 min before refresh token expires

function getXsuaaCredentials() {
  const services = xsenv.getServices({ xsuaa: { tag: 'xsuaa' } })
  const creds = services.xsuaa
  if (!creds) throw new Error('No XSUAA service binding found in VCAP_SERVICES')
  return {
    tokenUrl: `${creds.url}/oauth/token`,
    clientId: creds.clientid,
    clientSecret: creds.clientsecret
  }
}

function isTokenValid(expiresAt, bufferMs) {
  return expiresAt > 0 && Date.now() + bufferMs < expiresAt
}

async function fetchTokensUsingRefreshToken(refreshToken) {
  const { tokenUrl, clientId, clientSecret } = getXsuaaCredentials()
  console.log('[proxy] calling token endpoint:', tokenUrl)

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`
    },
    body: body.toString()
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Token refresh failed [${response.status}]: ${text}`)
  }

  const data = await response.json()
  if (!data.access_token) throw new Error('Token endpoint returned no access_token')
  return data
}

async function getAccessToken() {
  if (!tokenCache.refreshToken) {
    throw new Error('No refresh token available — set REFRESH_TOKEN environment variable')
  }

  // Check if refresh token itself is about to expire — get new tokens early
  const refreshTokenExpiring =
    tokenCache.refreshTokenExpiresAt > 0 &&
    !isTokenValid(tokenCache.refreshTokenExpiresAt, REFRESH_TOKEN_BUFFER_MS)

  // Return cached access token if still valid and refresh token is not expiring soon
  if (isTokenValid(tokenCache.accessTokenExpiresAt, ACCESS_TOKEN_BUFFER_MS) && !refreshTokenExpiring) {
    console.log('[proxy] using cached access token (expires in',
      Math.round((tokenCache.accessTokenExpiresAt - Date.now()) / 1000), 's)')
    return tokenCache.accessToken
  }

  console.log('[proxy] access token', refreshTokenExpiring ? 'refresh token expiring soon' : 'expired/missing', '— refreshing')
  const now = Date.now()
  const data = await fetchTokensUsingRefreshToken(tokenCache.refreshToken)

  // Update cached access token
  tokenCache.accessToken = data.access_token
  tokenCache.accessTokenExpiresAt = now + (data.expires_in || 3600) * 1000
  console.log('[proxy] access token cached, expires in', data.expires_in || 3600, 's')

  // Update cached refresh token if the server rotated it
  if (data.refresh_token) {
    tokenCache.refreshToken = data.refresh_token
    tokenCache.refreshTokenExpiresAt = data.refresh_token_expires_in
      ? now + data.refresh_token_expires_in * 1000
      : 0
    console.log('[proxy] refresh token updated', data.refresh_token_expires_in
      ? `(expires in ${data.refresh_token_expires_in} s)`
      : '(no expiry provided)')
  }

  return tokenCache.accessToken
}

function resolveDestination(req) {
  return (req.header('X-DESTINATION') || DEFAULT_DESTINATION || '').trim()
}

function relay(res, response) {
  const headers = response.headers?.toJSON?.() || response.headers
  if (response.statusText) res.writeHead(response.status, response.statusText, headers)
  else res.writeHead(response.status, headers)
  pipeline(response.data, res, error => {
    if (error && !res.destroyed) res.destroy(error)
  })
}

cds.on('bootstrap', app => {
  app.use(async (req, res) => {
    const destinationName = resolveDestination(req)

    if (!destinationName) {
      return res.status(400).json({
        error:
          'Missing destination. Provide header X-DESTINATION or set DEFAULT_DESTINATION/DESTINATION environment variable.'
      })
    }

    // 1. Use an incoming bearer token when present.
    // 2. Otherwise try the configured refresh token.
    // 3. With neither (or when refresh fails), use destination authentication.
    const authHeader = req.header('authorization') || ''
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
    let jwt = bearerMatch?.[1].trim() || undefined
    let jwtSource = jwt ? 'header' : 'destination'

    if (!jwt && tokenCache.refreshToken) {
      console.log('[proxy] no bearer token — attempting refresh token flow')
      try {
        jwt = await getAccessToken()
        jwtSource = 'refresh_token'
        console.log('[proxy] access token obtained via refresh token')
      } catch (err) {
        console.error('[proxy] refresh token flow failed:', err.message)
        console.log('[proxy] continuing without jwt — using destination-configured authentication')
      }
    } else if (!jwt) {
      console.log('[proxy] no bearer or refresh token — using destination-configured authentication')
    }

    // Use the caller JWT only for destination lookup. The SDK supplies backend
    // authentication and the separate Connectivity service proxy token.
    const headers = forwardHeaders(req)

    // Omitting the jwt property is intentional: an undefined jwt can still alter
    // destination lookup/authentication behavior in the Cloud SDK.
    const destination = jwt ? { destinationName, jwt } : { destinationName }

    console.log('[proxy] ------ incoming request ------')
    console.log('[proxy] method         :', req.method)
    console.log('[proxy] url            :', req.originalUrl)
    console.log('[proxy] destination    :', destinationName)
    console.log('[proxy] jwt present    :', !!jwt)
    console.log('[proxy] jwt source     :', jwtSource)

    try {
      const response = await executeHttpRequest(
        destination,
        {
          method: req.method,
          url: req.originalUrl,
          headers,
          middleware: [proxyRedirects],
          // Forward the untouched incoming bytes instead of a parsed body.
          data: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
          // Keep the destination response as a raw stream. Disabling automatic
          // decompression keeps content-encoding and content-length valid.
          responseType: 'stream',
          decompress: false,
          // Prevent axios from throwing on non-2xx — all HTTP responses are
          // returned as-is so we can proxy status + body straight to the client
          validateStatus: () => true,
          // Hard timeout so the request never hangs indefinitely
          timeout: PROXY_TIMEOUT_MS
        },
        // Let SAP Cloud SDK fetch the CSRF token and its matching session
        // cookies before modification requests (POST/PUT/PATCH/DELETE).
        { fetchCsrfToken: true }
      )
      console.log('[proxy] response received in time')

      console.log('[proxy] response status:', response.status)
      return relay(res, response)
    } catch (error) {
      console.error('[proxy] ------ destination call failed ------')
      console.error('[proxy] destination    :', destinationName)
      console.error('[proxy] error message  :', error.message)
      console.error('[proxy] stack trace    :\n', error.stack)

      const upstreamResponse = error.response || error.cause?.response
      if (upstreamResponse) {
        console.error('[proxy] http status    :', upstreamResponse.status)
        return relay(res, upstreamResponse)
      }

      const timedOut = ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code)
      const status = timedOut ? 504 : 502
      return res.status(status).json({
        error: 'Destination call failed',
        details: error.message
      })
    }
  })
})

module.exports = cds.server
