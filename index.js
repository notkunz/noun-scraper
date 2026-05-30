const express = require('express')
const puppeteer = require('puppeteer')
const cors = require('cors')

const app = express()
app.use(express.json())
app.use(cors({
  origin: [
    'https://noun-tma-assistant-two.vercel.app',
    'http://localhost:3000'
  ]
}))

// Secret key so only your app can call this server
const SECRET_KEY = process.env.SCRAPER_SECRET || 'noun-tma-secret-key'

app.get('/', (req, res) => {
  res.json({ status: 'NOUN Scraper running' })
})

// Add at top of /scrape-tma route handler
const SCRAPE_TIMEOUT = 120000 // 2 minutes

// Wrap browser operations in a promise with timeout
const scrapeWithTimeout = new Promise(async (resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error('Scraping timed out after 2 minutes'))
  }, SCRAPE_TIMEOUT)

  try {
    // ... all your browser code here
    clearTimeout(timer)
    resolve(results)
  } catch (err) {
    clearTimeout(timer)
    reject(err)
  }
})

const results = await scrapeWithTimeout

app.post('/scrape-tma', async (req, res) => {
  const { matric, password, secret } = req.body

  // Verify secret key
  if (secret !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!matric || !password) {
    return res.status(400).json({ error: 'Matric and password required' })
  }

  let browser = null

  try {
    console.log(`Starting scrape for ${matric}`)

browser = await puppeteer.launch({
  headless: 'new',
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
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--js-flags=--max-old-space-size=256'
  ]
})

    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

    // Step 1 — Go to NOUN login page
    console.log('Navigating to login page...')
    await page.goto('https://elearn.nou.edu.ng/login/index.php', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    // Step 2 — Fill in credentials
    console.log('Filling credentials...')
    await page.type('#username', matric, { delay: 50 })
    await page.type('#password', password, { delay: 50 })

    // Step 3 — Click login
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('#loginbtn')
    ])

    // Check if login failed
    const loginError = await page.$('.loginerrors, .alert-danger, #loginerrormessage')
    if (loginError) {
      await browser.close()
      return res.status(401).json({ error: 'Invalid NOUN credentials. Please check your matric number and password.' })
    }

    console.log('Login successful')

    // Step 4 — Find active TMA quizzes
    const currentUrl = page.url()
    console.log('Current URL after login:', currentUrl)

    // Navigate to My Courses
    await page.goto('https://elearn.nou.edu.ng/my/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    // Find all quiz/TMA links
    const quizLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/mod/quiz/"]'))
      return links
        .map(a => ({ href: a.href, text: a.innerText.trim() }))
        .filter(l => l.text.toLowerCase().includes('tma') || l.text.toLowerCase().includes('tutor'))
        .slice(0, 10)
    })

    console.log('Found quiz links:', quizLinks.length)

    if (quizLinks.length === 0) {
      await browser.close()
      return res.json({
        success: true,
        quizzes: [],
        message: 'No active TMA quizzes found on your dashboard'
      })
    }

    // Step 5 — Scrape questions from each quiz
    const results = []

    for (const quiz of quizLinks.slice(0, 5)) {
      try {
        console.log('Scraping quiz:', quiz.text)
        await page.goto(quiz.href, { waitUntil: 'domcontentloaded', timeout: 30000 })

        // Click attempt/start button if present
        const attemptBtn = await page.$('input[name="startattempt"], .singlebutton input[type="submit"]')
        if (attemptBtn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            attemptBtn.click()
          ])

          // Confirm if there's a confirmation dialog
          const confirmBtn = await page.$('input[type="submit"][value*="start"], button[type="submit"]')
          if (confirmBtn) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
              confirmBtn.click()
            ])
          }
        }

        // Scrape all questions and options from all pages
        const questions = []
        let hasNextPage = true

        while (hasNextPage) {
          const pageQuestions = await page.evaluate(() => {
            const qEls = document.querySelectorAll('.que')
            const qs = []

            qEls.forEach((el, index) => {
              // Get question text
              const qTextEl = el.querySelector('.qtext, .questiontext, .formulation')
              const questionText = qTextEl?.innerText?.trim() || ''

              // Get options
              const optionEls = el.querySelectorAll('.answer .r0, .answer .r1, .answer label')
              const options = []
              optionEls.forEach(opt => {
                const text = opt.innerText?.trim()
                if (text && text.length > 0) options.push(text)
              })

              if (questionText) {
                qs.push({ questionText, options, index: index + 1 })
              }
            })

            return qs
          })

          questions.push(...pageQuestions)

          // Check for next page button
          const nextBtn = await page.$('input[name="next"], .nextpage input, button.nextpage')
          if (nextBtn) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
              nextBtn.click()
            ])
          } else {
            hasNextPage = false
          }
        }

        if (questions.length > 0) {
          results.push({
            title: quiz.text,
            url: quiz.href,
            questions
          })
        }

      } catch (quizErr) {
        console.error('Error scraping quiz:', quiz.text, quizErr.message)
      }
    }

    await browser.close()
    console.log('Scraping complete. Quizzes:', results.length)

    return res.json({ success: true, quizzes: results })

  } catch (err) {
    console.error('Scraper error:', err)
    if (browser) await browser.close()
    return res.status(500).json({ error: 'Scraping failed: ' + err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`NOUN Scraper running on port ${PORT}`)
})