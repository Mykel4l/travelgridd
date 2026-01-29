// Cloudflare Worker API (itty-router) - partial conversion of your Express routes.
// Handles:
//  - GET  /api/health
//  - GET  /api/trains/search?from=&to=&date=YYYY-MM-DD
//  - GET  /api/buses/search?from=&to=
//  - GET  /api/flights/search?from=&to=&date=YYYY-MM-DD
//
// Environment bindings (set as Wrangler secrets/vars):
//  - RAPIDAPI_KEY      (secret)  - RapidAPI key for IRCTC
//  - RAPIDAPI_HOST     (optional) - default 'irctc-api2.p.rapidapi.com'
//  - DATA_GOV_API_KEY  (secret)  - api.data.gov.in key
//  - AVIATION_API_KEY  (secret)  - AviationStack key
//  - ALLOWED_ORIGINS   (optional) - comma-separated list of allowed CORS origins
//
// To add secret: `wrangler secret put RAPIDAPI_KEY`
import { Router } from 'itty-router'

const router = Router()

function parseAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS || ''
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'https://travel-grid.vercel.app'
  ]
}

function corsHeaders(origin, env) {
  const allowed = parseAllowedOrigins(env)
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  }
  // If no origin present (server-to-server), allow wildcard
  if (!origin) {
    headers['Access-Control-Allow-Origin'] = '*'
  } else if (allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  } else {
    // not allowed
    headers['Access-Control-Allow-Origin'] = 'null'
  }
  return headers
}

function jsonResponse(body, status = 200, origin = '', env = {}) {
  const headers = corsHeaders(origin, env)
  return new Response(JSON.stringify(body), { status, headers })
}

function queryParam(request, name) {
  const url = new URL(request.url)
  return url.searchParams.get(name) || ''
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return resp
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

// Health
router.get('/api/health', (req, env) => {
  const origin = req.headers.get('origin') || ''
  return jsonResponse({ message: 'API is running smoothly!' }, 200, origin, env)
})

// Preflight
router.options('*', (req, env) => {
  const origin = req.headers.get('origin') || ''
  return new Response('', { status: 204, headers: corsHeaders(origin, env) })
})

// Trains: IRCTC RapidAPI
router.get('/api/trains/search', async (req, env) => {
  const origin = req.headers.get('origin') || ''
  const from = queryParam(req, 'from')
  const to = queryParam(req, 'to')
  const date = queryParam(req, 'date')

  if (!from || !to || !date) {
    return jsonResponse({ message: 'Missing required query parameters: from, to, date' }, 400, origin, env)
  }

  const [year, month, day] = date.split('-')
  if (!year || !month || !day) {
    return jsonResponse({ message: 'Invalid date format. Expect YYYY-MM-DD' }, 400, origin, env)
  }
  const formattedDate = `${day}-${month}-${year}`

  const rapidKey = env.RAPIDAPI_KEY
  const rapidHost = env.RAPIDAPI_HOST || 'irctc-api2.p.rapidapi.com'
  if (!rapidKey) {
    return jsonResponse({ message: 'Server config error: RAPIDAPI_KEY missing' }, 500, origin, env)
  }

  const url = new URL('https://irctc-api2.p.rapidapi.com/trainAvailability')
  url.searchParams.set('source', from)
  url.searchParams.set('destination', to)
  url.searchParams.set('date', formattedDate)

  try {
    const resp = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': rapidKey,
        'X-RapidAPI-Host': rapidHost
      }
    }, 20000)

    if (!resp.ok) {
      const txt = await resp.text()
      return jsonResponse({ message: 'External API error', status: resp.status, body: txt }, 502, origin, env)
    }
    const json = await resp.json()
    const data = Array.isArray(json?.data) ? json.data : []
    return jsonResponse(data, 200, origin, env)
  } catch (err) {
    return jsonResponse({ message: 'Failed to fetch train data', error: String(err) }, 500, origin, env)
  }
})

// Buses: data.gov.in
router.get('/api/buses/search', async (req, env) => {
  const origin = req.headers.get('origin') || ''
  const from = queryParam(req, 'from')
  const to = queryParam(req, 'to')

  if (!from || !to) {
    return jsonResponse({ message: 'Missing required query parameters: from, to' }, 400, origin, env)
  }

  const apiKey = env.DATA_GOV_API_KEY
  const resourceUrl = 'https://api.data.gov.in/resource/1f10d3eb-a425-4246-8800-3f72bf7ad2b0'
  if (!apiKey) {
    return jsonResponse({ message: 'Server config error: DATA_GOV_API_KEY missing' }, 500, origin, env)
  }

  try {
    // get total count (limit=1)
    const countUrl = new URL(resourceUrl)
    countUrl.searchParams.set('api-key', apiKey)
    countUrl.searchParams.set('format', 'json')
    countUrl.searchParams.set('limit', '1')

    const countResp = await fetchWithTimeout(countUrl.toString(), {}, 20000)
    if (!countResp.ok) {
      const t = await countResp.text()
      return jsonResponse({ message: 'Failed to fetch bus data count', body: t }, 502, origin, env)
    }
    const countJson = await countResp.json()
    const total = Number(countJson?.total || 0)
    if (!total) return jsonResponse([], 200, origin, env)

    // fetch all records (careful: can be large)
    const allUrl = new URL(resourceUrl)
    allUrl.searchParams.set('api-key', apiKey)
    allUrl.searchParams.set('format', 'json')
    allUrl.searchParams.set('limit', String(total))

    const allResp = await fetchWithTimeout(allUrl.toString(), {}, 60000)
    if (!allResp.ok) {
      const t = await allResp.text()
      return jsonResponse({ message: 'Failed to fetch bus data', body: t }, 502, origin, env)
    }
    const allJson = await allResp.json()
    const records = Array.isArray(allJson?.records) ? allJson.records : []

    const filtered = records.filter(bus =>
      String(bus.from || '').toLowerCase().includes(from.toLowerCase()) &&
      String(bus.to || '').toLowerCase().includes(to.toLowerCase())
    )

    return jsonResponse(filtered, 200, origin, env)
  } catch (err) {
    return jsonResponse({ message: 'Failed to fetch bus data', error: String(err) }, 500, origin, env)
  }
})

// Flights: AviationStack
router.get('/api/flights/search', async (req, env) => {
  const origin = req.headers.get('origin') || ''
  const from = queryParam(req, 'from')
  const to = queryParam(req, 'to')
  const date = queryParam(req, 'date')

  if (!from || !to || !date) {
    return jsonResponse({ message: 'Missing required query parameters: from, to, date' }, 400, origin, env)
  }

  const apiKey = env.AVIATION_API_KEY
  if (!apiKey) {
    return jsonResponse({ message: 'Server config error: AVIATION_API_KEY missing' }, 500, origin, env)
  }

  const url = new URL('http://api.aviationstack.com/v1/flights')
  url.searchParams.set('access_key', apiKey)
  url.searchParams.set('limit', '100')

  try {
    const resp = await fetchWithTimeout(url.toString(), {}, 20000)
    if (!resp.ok) {
      const t = await resp.text()
      return jsonResponse({ message: 'Failed to fetch flight data', body: t }, 502, origin, env)
    }
    const json = await resp.json()
    const flights = Array.isArray(json?.data) ? json.data : []
    // note: original code filtered but returned allFlights — preserve returning flights
    return jsonResponse(flights, 200, origin, env)
  } catch (err) {
    return jsonResponse({ message: 'Failed to fetch flight data', error: String(err) }, 500, origin, env)
  }
})

// Catch-all for other /api routes not yet ported
router.all('/api/:rest*', (req, env) => {
  const origin = req.headers.get('origin') || ''
  return jsonResponse({
    success: false,
    message: 'API route not implemented in Worker yet. Provide Express route source to convert.',
  }, 501, origin, env)
})

router.all('*', () => new Response('Not Found', { status: 404 }))

export default {
  async fetch(request, env, ctx) {
    try {
      return await router.handle(request, env)
    } catch (err) {
      const origin = request.headers.get('origin') || ''
      return jsonResponse({ message: 'Internal Worker error', error: String(err) }, 500, origin, env)
    }
  }
}
