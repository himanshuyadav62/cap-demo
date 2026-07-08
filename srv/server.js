const cds = require('@sap/cds')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
const xsenv = require('@sap/xsenv')

const DEFAULT_DESTINATION =
  process.env.DEFAULT_DESTINATION || process.env.DESTINATION || ''

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

function buildForwardHeaders(req) {
  const headers = { ...req.headers }
  delete headers['x-destination']
  return headers
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

    // 1. Try the Authorization header from the incoming request
    // 2. Fall back to refresh token flow if header is absent
    const authHeader = req.header('authorization') || ''
    let jwt = authHeader.replace(/^Bearer\s+/i, '').trim() || undefined

    if (!jwt) {
      console.log('[proxy] no auth header — attempting refresh token flow')
      try {
        jwt = await getAccessToken()
        console.log('[proxy] access token obtained via refresh token')
      } catch (err) {
        console.error('[proxy] refresh token flow failed:', err.message)
      }
    }

    // Build forwarded headers; inject the obtained token if the request
    // did not carry an Authorization header itself
    const forwardHeaders = buildForwardHeaders(req)
    if (jwt && !authHeader) {
      forwardHeaders['authorization'] = `Bearer ${jwt}`
    }

    console.log('[proxy] ------ incoming request ------')
    console.log('[proxy] method         :', req.method)
    console.log('[proxy] url            :', req.originalUrl)
    console.log('[proxy] destination    :', destinationName)
    console.log('[proxy] jwt present    :', !!jwt)
    console.log('[proxy] jwt source     :', authHeader ? 'header' : jwt ? 'refresh_token' : 'none')
    console.log('[proxy] jwt (first 40) :', jwt ? jwt.substring(0, 40) + '...' : 'none')

    try {
      const response = await executeHttpRequest(
        { destinationName, jwt },
        {
          method: req.method,
          url: req.originalUrl,
          headers: forwardHeaders,
          data: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
          // Prevent axios from throwing on non-2xx — all HTTP responses are
          // returned as-is so we can proxy status + body straight to the client
          validateStatus: () => true
        }
      )

      if (response.headers) {
        Object.entries(response.headers).forEach(([key, value]) => {
          if (key.toLowerCase() !== 'transfer-encoding') {
            res.setHeader(key, value)
          }
        })
      }

      console.log('[proxy] response status:', response.status)
      return res.status(response.status).send(response.data)
    } catch (error) {
      // Only reaches here on network-level / SDK failures (no HTTP response)
      console.error('[proxy] ------ destination call failed ------')
      console.error('[proxy] destination    :', destinationName)
      console.error('[proxy] error message  :', error.message)
      console.error('[proxy] stack trace    :\n', error.stack)
      if (error.response) {
        console.error('[proxy] http status    :', error.response.status)
        console.error('[proxy] response body  :', JSON.stringify(error.response.data, null, 2))
      }
      return res.status(502).json({
        error: 'Destination call failed',
        details: error.message
      })
    }
  })
})

module.exports = cds.server
