/* global self, URLSearchParams */
// Gloss's phone client (SPEC → Remote and mobile): shows the desktop's pushes and opens their
// session. It caches nothing, so conversations never sit on the phone while it's offline.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : null
  if (!d) return
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body,
    icon: '/icon-192.png',
    tag: d.sessionId,
    data: { sessionId: d.sessionId, threadId: d.threadId }
  }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { sessionId, threadId } = e.notification.data || {}
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const client = open[0]
    if (client) {
      await client.focus()
      client.postMessage({ type: 'open', sessionId, threadId })
      return
    }
    const q = new URLSearchParams({ session: sessionId || '' })
    if (threadId) q.set('thread', threadId)
    await self.clients.openWindow(`/?${q}`)
  })())
})
