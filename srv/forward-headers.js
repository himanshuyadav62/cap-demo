// Authentication and proxy routing belong to the resolved BTP destination.
// Request-level headers take precedence over the Cloud SDK's generated headers.
module.exports = function forwardHeaders(req) {
  const blocked = new Set([
    'x-destination', 'authorization', 'proxy-authorization',
    'sap-connectivity-authentication', 'sap-connectivity-scc-location_id',
    'sap-cp-connectivity-service-token',
    'host', 'connection', 'proxy-connection', 'keep-alive',
    'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate'
  ])
  for (const token of (req.headers.connection || '').split(',')) {
    blocked.add(token.trim().toLowerCase())
  }
  return Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !blocked.has(name.toLowerCase()))
  )
}
