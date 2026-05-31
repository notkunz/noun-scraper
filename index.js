const express = require('express')
const puppeteer = require('puppeteer-core')
const cors = require('cors')

const app = express()
app.use(express.json())
app.use(cors())

const SECRET_KEY = process.env.SCRAPER_SECRET || 'noun-tma-secret-2024-olakunle'

app.get('/', (req, res) => {
  res.json({ status: 'NOUN Scraper running' })
})

app.post('/scrape-tma', async (req, res) => {
  const { matric, password, secret, tma_round } = req.body

  if (secret !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!matric || !password) {
    return res.status(400).json({ error: 'Matric and password required' })
  }

  const roundNumber = tma_round?.replace('TMA', '') || '1'
  let browser = null

  try {
    console.log(`Starting scrape for ${matric} — ${tma_round}`)

    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-images',
        '--blink-settings=imagesEnabled=false',
        '--js-flags=--max-old-space-size=256'
      ]
    })

    const page = await browser.newPage()

    // Block images, fonts and CSS to save memory
    await page.setRequestInterception(true)
    page.on('request', req => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort()
      } else {
        req.continue()
      }
    })

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    await page.setViewport({ width: 1280, height: 800 })

    // Login
    console.log('Navigating to login page...')
    await page.goto('https://elearn.nou.edu.ng/login/index.php', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    await page.type('#username', matric, { delay: 50 })
    await page.type('#password', password, { delay: 50 })

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('#loginbtn')
    ])

    const loginError = await page.$('.loginerrors, .alert-danger, #loginerrormessage')
    if (loginError) {
      await browser.close()
      return res.status(401).json({ error: 'Invalid NOUN credentials.' })
    }

    console.log('Login successful')

    // Go to dashboard and wait for course links to load
    await page.goto('https://elearn.nou.edu.ng/my/', {
      waitUntil: 'networkidle0',
      timeout: 45000
    })

    // Find TMA links
    const quizLinks = await page.evaluate((roundNum) => {
      const links = Array.from(document.querySelectorAll('a[href*="/mod/quiz/"]'))
      return links
        .map(a => ({ href: a.href, text: a.innerText.trim() }))
        .filter(l => {
          const text = l.text.toLowerCase()
          return (text.includes('tma') || text.includes('tutor marked')) &&
            text.includes(roundNum)
        })
        .slice(0, 30)
    }, roundNumber)

    console.log(`Found ${quizLinks.length} TMA${roundNumber} links`)

    if (quizLinks.length === 0) {
      await browser.close()
      return res.json({ success: true, quizzes: [], message: `No TMA${roundNumber} found` })
    }

    const results = []

    for (const quiz of quizLinks) {
      try {
        console.log('Scraping:', quiz.text)
        await page.goto(quiz.href, { waitUntil: 'domcontentloaded', timeout: 30000 })

        const courseCode = await page.evaluate(() => {
          const breadcrumb = document.querySelector('.breadcrumb, nav[aria-label] ol')
          const text = breadcrumb?.innerText || document.title || ''
          const match = text.match(/([A-Z]{2,4}\s*\d{3})/i)
          return match ? match[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
        })

  // Check current URL after navigation
let currentUrl = page.url()
console.log('Quiz page URL:', currentUrl)

// If we're on the view page, start the attempt
if (currentUrl.includes('mod/quiz/view.php') || currentUrl.includes('mod/quiz/')) {
  const attemptBtn = await page.$('input[name="startattempt"], .singlebutton input[type="submit"]')
  
  if (attemptBtn) {
    console.log('Clicking start attempt...')
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      attemptBtn.click()
    ])
    
    currentUrl = page.url()
    console.log('After attempt click:', currentUrl)
    
    // Handle confirmation page
    if (!currentUrl.includes('attempt.php')) {
      const confirmBtn = await page.$('button[type="submit"], input[type="submit"][value*="start" i], input[type="submit"]')
      if (confirmBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
          confirmBtn.click()
        ])
        currentUrl = page.url()
        console.log('After confirm:', currentUrl)
      }
    }
  } else {
    // Maybe attempt already started — look for "Continue the last attempt" button
    const continueBtn = await page.$('input[name="startattempt"], a[href*="attempt.php"]')
    if (continueBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        continueBtn.click()
      ])
      currentUrl = page.url()
      console.log('Continued existing attempt:', currentUrl)
    }
  }
}

// Wait for questions to appear
await page.waitForSelector('.que, .qtext, .questiontext', { timeout: 10000 }).catch(() => {
  console.log('No question selector found on page')
})

// Log page content for debugging
const pageTitle = await page.title()
console.log('Page title:', pageTitle)
console.log('Current URL:', page.url())


        const questions = []
        let hasNextPage = true
        let questionIndex = 1

        while (hasNextPage) {
const pageQuestions = await page.evaluate((startIndex) => {
  const qEls = document.querySelectorAll('.que')
  console.log('Found .que elements:', qEls.length) // this won't show in Node but helps
  
  // Also try alternative selectors
  const altEls = document.querySelectorAll('.formulation, .qtext, [class*="question"]')
  
  const qs = []
  const elements = qEls.length > 0 ? qEls : altEls
  
  elements.forEach((el) => {
    const qTextEl = el.querySelector('.qtext, .questiontext, .formulation') || el
    const questionText = qTextEl?.innerText?.trim() || ''
    const answerDiv = el.querySelector('.answer')
    const options = []
    if (answerDiv) {
      const optEls = answerDiv.querySelectorAll('div.r0, div.r1, label')
      optEls.forEach(opt => {
        const clone = opt.cloneNode(true)
        clone.querySelectorAll('input, .answernumber').forEach(e => e.remove())
        const text = clone.innerText?.trim()
        if (text && text.length > 0 && !text.match(/^[a-d]\.?$/i)) {
          options.push(text)
        }
      })
    }
    if (questionText && questionText.length > 5) {
      qs.push({ questionText, options, index: startIndex + qs.length })
    }
  })
  return qs
}, questionIndex)

// Log what we found
console.log(`Page questions found: ${pageQuestions.length}`)

          questions.push(...pageQuestions)
          questionIndex += pageQuestions.length

          const nextBtn = await page.$('input[name="next"], .mod_quiz-next-nav')
          if (nextBtn && pageQuestions.length > 0) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
              nextBtn.click()
            ])
          } else {
            hasNextPage = false
          }
        }

        console.log(`${courseCode}: ${questions.length} questions`)
        if (questions.length > 0) {
          results.push({ title: quiz.text, course_code: courseCode, url: quiz.href, questions })
        }

      } catch (quizErr) {
        console.error('Quiz error:', quiz.text, quizErr.message)
      }
    }

    await browser.close()
    console.log(`Done. ${results.length} courses scraped.`)
    return res.json({ success: true, quizzes: results })

  } catch (err) {
    console.error('Scraper error:', err)
    if (browser) { try { await browser.close() } catch (_) {} }
    return res.status(500).json({ error: 'Scraping failed: ' + err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`NOUN Scraper running on port ${PORT}`)
})