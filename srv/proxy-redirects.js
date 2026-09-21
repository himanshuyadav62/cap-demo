// Axios removes Proxy-Authorization on redirects, including same-origin ones.
// Restore the SDK's token only for the same destination and the same proxy.
module.exports = ({ fn }) => async request => {
  const proxy = request.proxy
  const token = Object.entries(request.headers || {})
    .find(([name]) => name.toLowerCase() === 'proxy-authorization')?.[1]
  if (!proxy || !token) return fn(request)

  const origin = new URL(request.baseURL).origin
  const proxyProtocol = `${proxy.protocol || 'http'}`.replace(/:$/, '') + ':'
  const proxyPort = String(proxy.port || (proxyProtocol === 'https:' ? 443 : 80))
  return fn({
    ...request,
    beforeRedirect(options) {
      const target = new URL(options.href)
      if (target.origin !== origin || target.username || target.password) {
        throw new Error('On-premise redirect leaves the destination origin. Check the Cloud Connector mapping and backend redirect URL.')
      }
      if (options.hostname !== proxy.host ||
          String(options.port || (options.protocol === 'https:' ? 443 : 80)) !== proxyPort ||
          options.protocol !== proxyProtocol) {
        throw new Error('On-premise redirect changed the connectivity proxy.')
      }
      // Run after Axios has reapplied its proxy settings and removed the token.
      options.headers['Proxy-Authorization'] = token
    }
  })
}
