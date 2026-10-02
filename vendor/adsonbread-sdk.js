;(function (window) {
  'use strict'

  const VERSION = '1.2.0'
  const defaultEdgeUrl = 'https://edge.adsonbread.com'
  const themes = {
    dark: {
      callout: '#a3a7ad',
      link: '#58bdfc',
      shadow: '0 2px 3px rgba(0,0,0,.35)',
      surface: '#20242b',
      text: '#e6e8eb',
    },
    light: {
      callout: '#888',
      link: '#088cdb',
      shadow: '0 2px 3px rgba(0,0,0,.15)',
      surface: '#F2F3F5',
      text: '#505050',
    },
  }

  function formatFromPlacement(placement) {
    return placement === 'card' ? 'card' : 'banner'
  }

  function themeFromOptions(options) {
    return options && options.theme === 'dark' ? themes.dark : themes.light
  }

  function edgeUrlFromOptions(options, fallback) {
    const value = options && typeof options.edgeUrl === 'string' ? options.edgeUrl.trim() : ''
    return value ? value.replace(/\/+$/, '') : fallback
  }

  const uidStorageKey = 'adsonbread_uid'
  const tokenLifetimeMs = 24 * 60 * 60 * 1000
  let cachedToken = null
  let tokenPromise = null

  function randomToken() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID()
    }

    return 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
  }

  function validToken(value, now = Date.now()) {
    return value && typeof value === 'object' && typeof value.id === 'string' && value.id &&
      Number.isFinite(value.expiresAt) && value.expiresAt > now
  }

  function createToken(now = Date.now()) {
    return { expiresAt: now + tokenLifetimeMs, id: randomToken() }
  }

  async function loadToken() {
    const now = Date.now()

    if (validToken(cachedToken, now)) return cachedToken.id

    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const stored = await chrome.storage.local.get(uidStorageKey)
        const value = stored && stored[uidStorageKey]

        if (validToken(value, now)) {
          cachedToken = value
          return cachedToken.id
        }

        cachedToken = createToken(now)
        await chrome.storage.local.set({ [uidStorageKey]: cachedToken })
        return cachedToken.id
      }
    } catch {
      // chrome.storage unavailable in this context, fall back to localStorage
    }

    try {
      const stored = window.localStorage.getItem(uidStorageKey)
      let value = null

      if (stored) {
        try {
          value = JSON.parse(stored)
        } catch {
          // SDK 1.0.0 stored a bare string. Replace it instead of carrying the
          // permanent identifier into the rotating-token design.
        }
      }

      if (validToken(value, now)) {
        cachedToken = value
        return cachedToken.id
      }

      cachedToken = createToken(now)
      window.localStorage.setItem(uidStorageKey, JSON.stringify(cachedToken))
      return cachedToken.id
    } catch {
      cachedToken = createToken(now)
      return cachedToken.id
    }
  }

  async function userToken() {
    if (validToken(cachedToken)) return cachedToken.id
    if (tokenPromise) return tokenPromise

    tokenPromise = loadToken().finally(() => {
      tokenPromise = null
    })

    return tokenPromise
  }

  function browserLanguage() {
    const language = (navigator.language || 'en').toLowerCase()

    if (language.indexOf('zh') === 0) {
      if (language.includes('tw') || language.includes('hk') || language.includes('mo') || language.includes('hant')) {
        return 'zh-hant'
      }

      return 'zh-hans'
    }

    return language.split('-')[0]
  }

  // Resolve the ad language: a manually passed Chrome i18n locale code wins
  // (e.g. 'es', 'pt_BR', 'zh_CN'); otherwise detect from the browser, which
  // itself falls back to English when the browser locale is unavailable.
  function languageFromOptions(options) {
    const value = options && typeof options.language === 'string' ? options.language.trim() : ''

    if (!value || value.toLowerCase() === 'auto') return browserLanguage()
    return value
  }

  function normalizeRanges(text, ranges) {
    if (!Array.isArray(ranges)) return []

    const normalized = ranges
      .map((range) => ({ end: Number(range.end), start: Number(range.start) }))
      .sort((a, b) => a.start - b.start)
    const valid = []
    let previousEnd = 0

    normalized.forEach((range) => {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return
      if (range.start < previousEnd || range.start < 0 || range.end > text.length || range.start >= range.end) return
      valid.push(range)
      previousEnd = range.end
    })

    return valid
  }

  function clickHref(baseUrl, clickUrl) {
    if (!clickUrl) return '#'
    return clickUrl.charAt(0) === '/' ? baseUrl + clickUrl : clickUrl
  }

  function bannerSegmentText(value) {
    return value.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ')
  }

  function appendLinkedText(parent, text, ranges, linkColor, transformSegment = (value) => value) {
    let cursor = 0

    ranges.forEach((range) => {
      if (range.start > cursor) {
        parent.appendChild(document.createTextNode(transformSegment(text.slice(cursor, range.start))))
      }

      const link = document.createElement('span')
      link.textContent = transformSegment(text.slice(range.start, range.end))
      link.style.cssText = `color:${linkColor};text-decoration:none;font-size:12.5px;font-weight:500;display:inline`
      link.addEventListener('mouseenter', () => {
        link.style.textDecoration = 'underline'
      })
      link.addEventListener('mouseleave', () => {
        link.style.textDecoration = 'none'
      })
      parent.appendChild(link)
      cursor = range.end
    })

    if (cursor < text.length) {
      parent.appendChild(document.createTextNode(transformSegment(text.slice(cursor))))
    }
  }

  function calloutText(ad) {
    return 'Ad by AdsOnBread for ' + (ad.extensionName || ad.extension_name || 'this extension')
  }

  async function requestAd(apiKey, placement, options) {
    const edgeUrl = edgeUrlFromOptions(options || {}, defaultEdgeUrl)

    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2000)
      const token = await userToken()
      const response = await fetch(edgeUrl + '/ad', {
        body: JSON.stringify({
          api_key: apiKey,
          language: languageFromOptions(options || {}),
          placement: formatFromPlacement(placement),
          sdk_version: VERSION,
          token,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: ctrl.signal,
      })
      clearTimeout(timer)

      if (!response.ok) return null

      const result = await response.json()
      return { ad: result.ad || null, token }
    } catch {
      return null
    }
  }

  function render(container, ad, placement, options) {
    if (!container || !ad) return

    const format = ad.format === 'card' || placement === 'card' ? 'card' : 'banner'
    const theme = themeFromOptions(options || {})
    const edgeUrl = edgeUrlFromOptions(options || {}, defaultEdgeUrl)
    const text = String(ad.text || '')
    const ranges = normalizeRanges(text, ad.linkRanges || ad.link_ranges)
    const href = clickHref(edgeUrl, ad.clickUrl || ad.click_url)
    const iconUrl = ad.iconUrl || ad.icon_url

    const wrap = document.createElement('div')
    wrap.setAttribute('data-adsonbread', 'true')
    wrap.style.cssText = [
      'display:inline-flex',
      'flex-direction:column',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
      format === 'card' ? 'width:180px' : 'max-width:500px;min-width:300px;width:100%',
    ].join(';')

    const content = document.createElement('a')
    content.href = href
    content.target = '_blank'
    content.rel = 'noopener noreferrer sponsored'
    content.style.cssText = format === 'card'
      ? `display:block;background-color:${theme.surface};border-radius:4px;box-shadow:${theme.shadow};overflow:hidden;text-decoration:none`
      : `display:flex;flex-direction:row;align-items:center;gap:12px;padding:8px 12px 8px 8px;color:${theme.text};background-color:${theme.surface};border-radius:4px 4px 0 0;box-shadow:${theme.shadow};min-height:64px;box-sizing:border-box;text-decoration:none`

    const imageWrap = document.createElement('div')
    imageWrap.style.cssText = format === 'card'
      ? 'width:100%;padding:16px 16px 12px;box-sizing:border-box;display:flex;justify-content:center'
      : 'flex-shrink:0'

    if (iconUrl) {
      const image = document.createElement('img')
      image.src = iconUrl
      image.alt = 'Logo'
      image.style.cssText = 'width:48px;height:48px;border-radius:3px;display:block;object-fit:cover'
      imageWrap.appendChild(image)
    }

    if (format === 'card') {
      const body = document.createElement('div')
      body.style.cssText = 'padding:0 14px 12px;display:flex;flex-direction:column;gap:10px'
      const paragraph = document.createElement('p')
      paragraph.style.cssText = `font-size:12.5px;line-height:1.5;color:${theme.text};margin:0;white-space:pre-line`
      appendLinkedText(paragraph, text, ranges, theme.link)
      body.appendChild(paragraph)
      content.appendChild(imageWrap)
      content.appendChild(body)
    } else {
      const textBlock = document.createElement('div')
      textBlock.style.cssText = `font-size:13px;line-height:1.45;color:${theme.text}`
      appendLinkedText(textBlock, text, ranges, theme.link, bannerSegmentText)
      content.appendChild(imageWrap)
      content.appendChild(textBlock)
    }

    const callout = document.createElement('div')
    callout.style.cssText = format === 'card'
      ? 'padding:5px 4px 0;text-align:right'
      : 'display:flex;justify-content:flex-end;align-items:center;padding:4px 8px;background-color:transparent'
    const calloutLink = document.createElement('a')
    calloutLink.href = 'https://adsonbread.com'
    calloutLink.target = '_blank'
    calloutLink.rel = 'noopener noreferrer'
    calloutLink.textContent = calloutText(ad)
    calloutLink.style.cssText = `font-size:10px;color:${format === 'card' && theme === themes.light ? '#aaa' : theme.callout};text-decoration:none;letter-spacing:0.01em;white-space:nowrap`
    callout.appendChild(calloutLink)

    wrap.appendChild(content)
    wrap.appendChild(callout)
    container.innerHTML = ''
    container.appendChild(wrap)
    return wrap
  }

  const activeObservers = new WeakMap()

  function visibleFraction(element) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return 0
    const left = Math.max(0, rect.left)
    const top = Math.max(0, rect.top)
    const right = Math.min(window.innerWidth, rect.right)
    const bottom = Math.min(window.innerHeight, rect.bottom)
    if (right <= left || bottom <= top) return 0
    let unobscured = 0
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const point = document.elementFromPoint(
          left + ((col + 0.5) / 5) * (right - left),
          top + ((row + 0.5) / 5) * (bottom - top),
        )
        if (point && (point === element || element.contains(point))) unobscured += 1
      }
    }
    return ((right - left) * (bottom - top) / (rect.width * rect.height)) * unobscured / 25
  }

  function observeView(element, ad, apiKey, edgeUrl, token) {
    const impressionId = ad.impressionId || ad.impression_id
    if (!impressionId || typeof IntersectionObserver !== 'function') return () => {}
    let startedAt = null
    let timer = null
    let lastRatio = 0
    let visibleByObserver = false
    let completed = false
    const reset = () => {
      startedAt = null
      if (timer) clearTimeout(timer)
      timer = null
    }
    const isActive = () => element.isConnected && document.visibilityState === 'visible' &&
      visibleByObserver && lastRatio > 0.7 && visibleFraction(element) > 0.7
    const confirm = async () => {
      timer = null
      const records = observer.takeRecords ? observer.takeRecords() : []
      if (records.length) {
        const latest = records[records.length - 1]
        lastRatio = latest.intersectionRatio
        visibleByObserver = latest.isVisible !== false
      }
      if (!isActive() || completed || startedAt === null) { reset(); return }
      const duration = performance.now() - startedAt
      if (duration < 1000) { timer = setTimeout(confirm, 1000 - duration); return }
      completed = true
      observer.disconnect()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      const body = JSON.stringify({ api_key: apiKey, impression_id: impressionId,
        sdk_version: VERSION, token, visible_ratio: Math.min(lastRatio, visibleFraction(element)),
        duration_ms: Math.floor(duration), page_visible: true })
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(edgeUrl + '/view', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
          })
          if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 409)) return
        } catch {
          // A transient connection failure can be retried while the page is open.
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') reset()
      else if (isActive()) { startedAt = performance.now(); timer = setTimeout(confirm, 1000) }
    }
    const supportsTrackVisibility = typeof IntersectionObserverEntry !== 'undefined' &&
      'isVisible' in IntersectionObserverEntry.prototype
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      lastRatio = entry.intersectionRatio
      visibleByObserver = entry.isVisible !== false
      if (!isActive()) { reset(); return }
      if (startedAt === null) { startedAt = performance.now(); timer = setTimeout(confirm, 1000) }
    }, supportsTrackVisibility
      ? { threshold: [0, 0.7, 0.71, 1], trackVisibility: true, delay: 100 }
      : { threshold: [0, 0.7, 0.71, 1] })
    observer.observe(element)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const poll = setInterval(() => {
      if (!isActive()) reset()
      else if (startedAt === null) { startedAt = performance.now(); timer = setTimeout(confirm, 1000) }
    }, 200)
    return () => {
      reset()
      observer.disconnect()
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }

  const AdsOnBread = {
    version: VERSION,

    async load(apiKey, placement, container, options) {
      const format = formatFromPlacement(placement)
      const result = await requestAd(apiKey, format, options || {})
      const ad = result && result.ad
      if (ad && container) {
        const oldObserver = activeObservers.get(container)
        if (oldObserver) oldObserver()
        const element = render(container, ad, format, options || {})
        activeObservers.set(container, observeView(element, ad, apiKey,
          edgeUrlFromOptions(options || {}, defaultEdgeUrl), result.token))
      }
      return ad
    },
  }

  window.AdsOnBread = AdsOnBread
})(window)
