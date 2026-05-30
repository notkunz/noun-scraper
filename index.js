const express = require('express')
const cors = require('cors')
const https = require('https')
const http = require('http')

const app = express()
app.use(express.json())
app.use(cors())

const SECRET_KEY = process.env.SCRAPER_SECRET || 'noun-tma-secret-2024-olakunle'

app.get('/', (req, res) => {
  res.json({ status: 'NOUN Scraper running' })
})

// Simple HTTP fetch helper with cookie support
function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const lib = urlObj.protocol === 'https:' ? https : http
    
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        ...options.headers
      }
    }

    const req = lib.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ 
        status: res.statusCode, 
        headers: res.headers, 
        body: data,
        location: res.headers.location
      }))
    })

    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function extractLoginToken(html) {
  const match = html.match(/name="logintoken"\s+value="([^"]+)"/)
  return match ? match[1] : ''
}

/*function extractQuizLinks(html, roundNumber) {
  const links = []
  const linkRegex = /href="(https:\/\/elearn\.nou\.edu\.ng\/mod\/quiz\/[^"]+)">([^<]+)</g
  let match
  while ((match = linkRegex.exec(html)) !== null) {
    const text = match[2].toLowerCase()
    if ((text.includes('tma') || text.includes('tutor marked')) && 
        text.includes(roundNumber)) {
      links.push({ href: match[1], text: match[2].trim() })
    }
  }
  return [...new Map(links.map(l => [l.href, l])).values()].slice(0, 30)
}*/
function extractQuizLinks(html, roundNumber) {
  const links = []

  // match ALL quiz links (absolute + relative)
  const linkRegex = /href="([^"]*\/mod\/quiz\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g

  let match
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1]
    const text = match[2].replace(/<[^>]*>/g, '').trim()
    const lower = text.toLowerCase()

    // MUCH LOOSER matching (important)
    const isQuiz =
      lower.includes('quiz') ||
      lower.includes('tma') ||
      lower.includes('assignment') ||
      lower.includes('assessment')

    const matchesRound =
      roundNumber === '1'
        ? lower.includes('1') || lower.includes('i')
        : lower.includes(roundNumber)

    if (isQuiz && matchesRound) {
      const fullUrl = href.startsWith('http')
        ? href
        : `https://elearn.nou.edu.ng${href}`

      links.push({
        href: fullUrl,
        text
      })
    }
  }

  return [...new Map(links.map(l => [l.href, l])).values()]
}

function extractCourseCode(html) {
  const match = html.match(/([A-Z]{2,4}\s*\d{3})/i)
  return match ? match[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
}

function extractQuestions(html) {
  const questions = []
  
  // Match question blocks
  const queRegex = /<div[^>]+class="[^"]*\bque\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*\bque\b|$)/g
  let queMatch
  let index = 1

  while ((queMatch = queRegex.exec(html)) !== null) {
    const block = queMatch[1]
    
    // Extract question text
    const qtextMatch = block.match(/<div[^>]+class="[^"]*\bqtext\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (!qtextMatch) continue
    
    const questionText = qtextMatch[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .trim()

    if (!questionText || questionText.length < 5) continue

    // Extract options
    const options = []
    const optRegex = /<div[^>]+class="[^"]*\br[01]\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g
    let optMatch
    while ((optMatch = optRegex.exec(block)) !== null) {
      const optText = optMatch[1]
        .replace(/<input[^>]*>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim()
      if (optText && optText.length > 0 && !optText.match(/^[a-d]\.?$/i)) {
        options.push(optText)
      }
    }

    questions.push({ questionText, options, index: index++ })
  }

  return questions
}

app.post('/scrape-tma', async (req, res) => {
  const { matric, password, secret, tma_round } = req.body

  if (secret !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!matric || !password) {
    return res.status(400).json({ error: 'Matric and password required' })
  }

  const roundNumber = tma_round?.replace('TMA', '') || '1'
  let cookies = ''

  try {
    console.log(`Starting HTTP scrape for ${matric} — ${tma_round}`)

    // Step 1 — Get login page to extract token
    const loginPage = await httpFetch('https://elearn.nou.edu.ng/login/index.php')
    
    // Save initial cookies
    const setCookie = loginPage.headers['set-cookie']
    if (setCookie) {
      cookies = setCookie.map(c => c.split(';')[0]).join('; ')
    }

    const loginToken = extractLoginToken(loginPage.body)
    console.log('Got login token:', loginToken ? 'yes' : 'no')

    // Step 2 — POST login credentials
    const loginBody = new URLSearchParams({
      username: matric,
      password: password,
      logintoken: loginToken,
      anchor: ''
    }).toString()

    const loginRes = await httpFetch('https://elearn.nou.edu.ng/login/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Referer': 'https://elearn.nou.edu.ng/login/index.php'
      },
      body: loginBody
    })

    // Update cookies from login response
    const loginCookies = loginRes.headers['set-cookie']
    if (loginCookies) {
      const newCookies = loginCookies.map(c => c.split(';')[0])
      const cookieMap = new Map(cookies.split('; ').map(c => c.split('=')))
      newCookies.forEach(c => {
        const [k, v] = c.split('=')
        cookieMap.set(k, v)
      })
      cookies = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
    }

    // Check if login failed — still on login page
    if (loginRes.body.includes('loginerrormessage') || loginRes.body.includes('Invalid login')) {
      return res.status(401).json({ error: 'Invalid NOUN credentials. Check your matric and password.' })
    }

    console.log('Login successful')

    // Step 3 — Get dashboard
    const dashboardRes = await httpFetch('https://elearn.nou.edu.ng/my/', {
      headers: { 'Cookie': cookies }
    })

    // Follow redirect if needed
    let dashboardHtml = dashboardRes.body
    if (dashboardRes.status === 303 || dashboardRes.status === 302) {
      const redirectRes = await httpFetch(dashboardRes.location || 'https://elearn.nou.edu.ng/my/', {
        headers: { 'Cookie': cookies }
      })
      dashboardHtml = redirectRes.body
    }
      console.log("Dashboard URL loaded")
console.log("Dashboard length:", dashboardHtml.length)
console.log("Dashboard preview:")
console.log(dashboardHtml.substring(0, 3000))
    // Step 4 — Find TMA quiz links
    const quizLinks = extractQuizLinks(dashboardHtml, roundNumber)
    console.log(`Found ${quizLinks.length} TMA${roundNumber} links`)

    if (quizLinks.length === 0) {
      return res.json({ success: true, quizzes: [], message: `No TMA${roundNumber} found` })
    }

    // Step 5 — Scrape each quiz
    const results = []

    for (const quiz of quizLinks.slice(0, 20)) {
      try {
        console.log('Scraping:', quiz.text)
        
        const quizPage = await httpFetch(quiz.href, {
          headers: { 'Cookie': cookies }
        })

        const courseCode = extractCourseCode(quizPage.body)

        // Check if we need to start attempt
        let quizHtml = quizPage.body
        
        if (quizHtml.includes('startattempt') || quizHtml.includes('Start attempt')) {
          // Extract sesskey
          const sesskeyMatch = quizHtml.match(/sesskey=([a-zA-Z0-9]+)/)
          const sesskey = sesskeyMatch ? sesskeyMatch[1] : ''
          
          const attemptBody = new URLSearchParams({
            sesskey,
            _qf__mod_quiz_view_form: '1',
            startattempt: '1'
          }).toString()

          const attemptRes = await httpFetch(quiz.href, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': cookies,
              'Referer': quiz.href
            },
            body: attemptBody
          })

          quizHtml = attemptRes.body

          // Follow redirect
          if (attemptRes.status === 303 || attemptRes.status === 302) {
            const redirectUrl = attemptRes.location
            if (redirectUrl) {
              const redirectRes = await httpFetch(redirectUrl, {
                headers: { 'Cookie': cookies }
              })
              quizHtml = redirectRes.body
            }
          }
        }

        // Extract questions from all pages
        const questions = []
        let currentHtml = quizHtml
        let hasNext = true

        while (hasNext) {
          const pageQuestions = extractQuestions(currentHtml)
          questions.push(...pageQuestions)

          // Check for next page
          if (currentHtml.includes('name="next"') || currentHtml.includes('mod_quiz-next-nav')) {
            const nextUrlMatch = currentHtml.match(/action="([^"]+)"/)
            const sesskeyMatch = currentHtml.match(/name="sesskey"\s+value="([^"]+)"/)
            const pageMatch = currentHtml.match(/name="page"\s+value="(\d+)"/)
            
            if (nextUrlMatch && sesskeyMatch && pageMatch) {
              const nextPage = parseInt(pageMatch[1]) + 1
              const nextBody = new URLSearchParams({
                sesskey: sesskeyMatch[1],
                next: '1',
                page: String(nextPage)
              }).toString()

              const nextRes = await httpFetch(nextUrlMatch[1], {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Cookie': cookies
                },
                body: nextBody
              })
              currentHtml = nextRes.body
            } else {
              hasNext = false
            }
          } else {
            hasNext = false
          }
        }

        console.log(`${courseCode}: ${questions.length} questions`)

        if (questions.length > 0) {
          results.push({
            title: quiz.text,
            course_code: courseCode,
            url: quiz.href,
            questions
          })
        }

      } catch (quizErr) {
        console.error('Quiz error:', quiz.text, quizErr.message)
      }
    }

    console.log(`Done. ${results.length} courses scraped.`)
    return res.json({ success: true, quizzes: results })

  } catch (err) {
    console.error('Scraper error:', err)
    return res.status(500).json({ error: 'Scraping failed: ' + err.message })
  }
})

const PORT = process.env.PORT || 3001
app.post('/debug-login', async (req, res) => {
  const { matric, password, secret } = req.body

  if (secret !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let cookies = ''

  try {
    const loginPage = await httpFetch('https://elearn.nou.edu.ng/login/index.php')
    const setCookie = loginPage.headers['set-cookie']
    if (setCookie) {
      cookies = setCookie.map(c => c.split(';')[0]).join('; ')
    }

    const loginToken = extractLoginToken(loginPage.body)

    const loginBody = new URLSearchParams({
      username: matric,
      password: password,
      logintoken: loginToken,
      anchor: ''
    }).toString()

    const loginRes = await httpFetch('https://elearn.nou.edu.ng/login/index.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'Referer': 'https://elearn.nou.edu.ng/login/index.php'
      },
      body: loginBody
    })

    const loginCookies = loginRes.headers['set-cookie']
    if (loginCookies) {
      const newCookies = loginCookies.map(c => c.split(';')[0])
      const cookieMap = new Map(cookies.split('; ').filter(Boolean).map(c => {
        const idx = c.indexOf('=')
        return [c.slice(0, idx), c.slice(idx + 1)]
      }))
      newCookies.forEach(c => {
        const idx = c.indexOf('=')
        cookieMap.set(c.slice(0, idx), c.slice(idx + 1))
      })
      cookies = Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
    }

    const dashboardRes = await httpFetch('https://elearn.nou.edu.ng/my/', {
      headers: { 'Cookie': cookies }
    })

    // Return first 5000 chars of dashboard HTML so we can see what's there
    return res.json({
      status: dashboardRes.status,
      loginFailed: loginRes.body.includes('loginerrormessage'),
      dashboardSnippet: dashboardRes.body.slice(0, 5000),
      quizLinksFound: (dashboardRes.body.match(/mod\/quiz/g) || []).length,
      tmaLinksFound: (dashboardRes.body.match(/tma/gi) || []).length
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`NOUN Scraper running on port ${PORT}`)
})