const express = require('express')
const puppeteer = require('puppeteer')
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
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
        '--js-flags=--max-old-space-size=256'
      ]
    })

    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1280, height: 800 })

    // Login
    console.log('Navigating to login page...')
    await page.goto('https://elearn.nou.edu.ng/login/index.php', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    await page.type('#username', matric, { delay: 80 })
    await page.type('#password', password, { delay: 80 })

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('#loginbtn')
    ])

    const loginError = await page.$('.loginerrors, .alert-danger, #loginerrormessage')
    if (loginError) {
      await browser.close()
      return res.status(401).json({ error: 'Invalid NOUN credentials. Check your matric and password.' })
    }

    console.log('Login successful')

    // Go to dashboard
    await page.goto('https://elearn.nou.edu.ng/my/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    // Find TMA links for this round
    const quizLinks = await page.evaluate((roundNum) => {
      const links = Array.from(document.querySelectorAll('a[href*="/mod/quiz/"]'))
      return links
        .map(a => ({ href: a.href, text: a.innerText.trim() }))
        .filter(l => {
          const text = l.text.toLowerCase()
          return (
            (text.includes('tma') || text.includes('tutor marked')) &&
            text.includes(roundNum)
          )
        })
        .slice(0, 30)
    }, roundNumber)

    console.log(`Found ${quizLinks.length} TMA${roundNumber} links`)

    if (quizLinks.length === 0) {
      await browser.close()
      return res.json({
        success: true,
        quizzes: [],
        message: `No TMA${roundNumber} found on your dashboard`
      })
    }

    // Scrape each quiz
    const results = []

    for (const quiz of quizLinks) {
      try {
        console.log('Scraping:', quiz.text)
        await page.goto(quiz.href, { waitUntil: 'domcontentloaded', timeout: 30000 })

        // Get course code from breadcrumb
        const courseCode = await page.evaluate(() => {
          const breadcrumb = document.querySelector('.breadcrumb, nav[aria-label] ol')
          const text = breadcrumb?.innerText || document.title || ''
          const match = text.match(/([A-Z]{2,4}\s*\d{3})/i)
          return match ? match[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
        })

        // Click start/attempt button
        const attemptBtn = await page.$('input[name="startattempt"]')
        if (attemptBtn) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            attemptBtn.click()
          ])

          const confirmBtn = await page.$('button[type="submit"], input[type="submit"]')
          if (confirmBtn) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
              confirmBtn.click()
            ])
          }
        }

        // Scrape questions across all pages
        const questions = []
        let hasNextPage = true
        let questionIndex = 1

        while (hasNextPage) {
          const pageQuestions = await page.evaluate((startIndex) => {
            const qEls = document.querySelectorAll('.que')
            const qs = []

            qEls.forEach((el) => {
              const qTextEl = el.querySelector('.qtext, .questiontext, .formulation')
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

          questions.push(...pageQuestions)
          questionIndex += pageQuestions.length

          // Check for next page
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

        console.log(`${courseCode}: ${questions.length} questions found`)

        if (questions.length > 0) {
          results.push({
            title: quiz.text,
            course_code: courseCode,
            url: quiz.href,
            questions
          })
        }

      } catch (quizErr) {
        console.error('Error scraping quiz:', quiz.text, quizErr.message)
      }
    }

    await browser.close()
    console.log(`Scraping complete. ${results.length} courses scraped.`)

    return res.json({ success: true, quizzes: results })

  } catch (err) {
    console.error('Scraper error:', err)
    if (browser) {
      try { await browser.close() } catch (_) {}
    }
    return res.status(500).json({ error: 'Scraping failed: ' + err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`NOUN Scraper running on port ${PORT}`)
})