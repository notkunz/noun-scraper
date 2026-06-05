const express = require('express')
const puppeteer = require('puppeteer-core')
const cors = require('cors')
const { createClient } = require('@supabase/supabase-js')
const Groq = require('groq-sdk')
const ws = require('ws')

const app = express()
app.use(express.json())
app.use(cors())

const SECRET_KEY = process.env.SCRAPER_SECRET || 'noun-tma-secret-2024-olakunle'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } }
)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
let isRunning = false

// ─── Helpers ────────────────────────────────────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--single-process', '--js-flags=--max-old-space-size=256'
    ]
  })
}

async function setupPage(browser) {
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', r => {
    if (['image', 'stylesheet', 'font', 'media'].includes(r.resourceType())) r.abort()
    else r.continue()
  })
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
  await page.setViewport({ width: 1280, height: 800 })
  return page
}

async function loginToNOUN(page, matric, password) {
  await page.goto('https://elearn.nou.edu.ng/login/index.php', {
    waitUntil: 'domcontentloaded', timeout: 30000
  })
  await page.type('#username', matric, { delay: 50 })
  await page.type('#password', password, { delay: 50 })
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.click('#loginbtn')
  ])
  const loginError = await page.$('.loginerrors, .alert-danger, #loginerrormessage')
  return !loginError
}

async function findTMALinks(page, roundNumber) {
  await page.goto('https://elearn.nou.edu.ng/my/courses.php', {
    waitUntil: 'domcontentloaded', timeout: 45000
  })

  // Scroll to trigger lazy loading
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await new Promise(r => setTimeout(r, 800))
  }

  try {
    await page.waitForSelector('a[href*="/course/view"]', { timeout: 10000 })
  } catch (_) {}

  const courseLinks = await page.evaluate(() => {
    const seen = new Set()
    return Array.from(document.querySelectorAll('a[href*="/course/view"]'))
      .map(a => ({ href: a.href.split('#')[0], text: a.innerText.trim() }))
      .filter(l => {
        if (!l.text || l.text.length < 2 || seen.has(l.href)) return false
        seen.add(l.href)
        return true
      })
  })

  console.log(`Found ${courseLinks.length} course links`)

  const quizLinks = []

  for (const course of courseLinks) {
    try {
      await page.goto(course.href, { waitUntil: 'domcontentloaded', timeout: 20000 })
      
      // Wait for page content to load
      await new Promise(r => setTimeout(r, 1500))
      
      // Scroll to load all course content
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await new Promise(r => setTimeout(r, 500))

      const found = await page.evaluate((roundNum) => {
        // Try multiple selectors
        const allLinks = Array.from(document.querySelectorAll('a'))
        return allLinks
          .map(a => ({ href: a.href, text: a.innerText.trim() }))
          .filter(l => {
            if (!l.href.includes('/mod/quiz/')) return false
            const text = l.text.toLowerCase()
            const isTMA = text.includes('tma') || text.includes('tutor marked')
            const exactRound =
              new RegExp(`tma\\s*${roundNum}(\\b|\\s|$)`, 'i').test(text) ||
              new RegExp(`tutor marked assignment\\s*${roundNum}(\\b|\\s|$)`, 'i').test(text)
            return isTMA && exactRound
          })
      }, roundNumber)

      if (found.length > 0) {
        console.log(`Found TMA${roundNumber} in ${course.text}: ${found.length} link(s)`)
        quizLinks.push(...found)
      }
    } catch (e) {
      console.log('Error checking course:', course.text, e.message)
    }
  }

  return { quizLinks, totalCourses: courseLinks.length }
}

async function navigateToAttempt(page, runId) {
  console.log('navigateToAttempt — current URL:', page.url())
  
  if (page.url().includes('attempt.php')) {
    console.log('Already on attempt page')
    // Still go to page 0
    if (page.url().includes('&page=')) {
      const base = page.url().split('&page=')[0]
      await page.goto(`${base}&page=0`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    }
    return
  }

  await new Promise(r => setTimeout(r, 1000))

  // Log all buttons on page
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], a[href*="attempt"]'))
      .map(el => ({ tag: el.tagName, name: el.name || '', value: el.value || el.innerText?.trim().slice(0, 30), href: el.href || '' }))
  })
  console.log('Buttons on page:', JSON.stringify(buttons))

  const startBtn = await page.$('input[name="startattempt"]')
  if (startBtn) {
    console.log('Clicking startattempt...')
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        startBtn.click()
      ])
      console.log('After start:', page.url())
    } catch (e) {
      console.log('Start click error:', e.message)
    }
  }

  if (!page.url().includes('attempt.php')) {
    const confirmBtn = await page.$('button[type="submit"], input[type="submit"]')
    if (confirmBtn) {
      console.log('Clicking confirm...')
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
          confirmBtn.click()
        ])
        console.log('After confirm:', page.url())
      } catch (e) {
        console.log('Confirm click error:', e.message)
      }
    }
  }

  if (!page.url().includes('attempt.php')) {
    const continueLink = await page.$('a[href*="attempt.php"]')
    if (continueLink) {
      const href = await page.evaluate(a => a.href, continueLink)
      console.log('Following continue link:', href)
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } else {
      console.log('No attempt navigation found — final URL:', page.url())
    }
  }

  if (page.url().includes('attempt.php') && page.url().includes('&page=')) {
    const base = page.url().split('&page=')[0]
    console.log('Going to page 0:', `${base}&page=0`)
    await page.goto(`${base}&page=0`, { waitUntil: 'domcontentloaded', timeout: 20000 })
  }

  console.log('navigateToAttempt done — final URL:', page.url())

  // Wait for attempt page to fully render
  if (page.url().includes('attempt.php')) {
    await new Promise(r => setTimeout(r, 2000))
  }

  console.log('navigateToAttempt done — final URL:', page.url())
}

async function scrapeQuestions(page) {
  try {
    await page.waitForSelector('.que', { timeout: 10000 })
  } catch (_) {
    // Log what's actually on the page
    const info = await page.evaluate(() => ({
      url: location.href,
      queCount: document.querySelectorAll('.que').length,
      bodyText: document.body.innerText.slice(0, 200)
    }))
    console.log('No .que found:', JSON.stringify(info))
    return []
  }

  const questions = []
  let hasNext = true
  let qi = 1

  while (hasNext) {
    const pqs = await page.evaluate((si) => {
      return Array.from(document.querySelectorAll('.que')).map((el, idx) => {
        const clone = el.cloneNode(true)
        clone.querySelectorAll('.answer, .outcome, .comment, .gradingdetails, input, button, .clearfix').forEach(e => e.remove())
        const questionText = clone.querySelector('.qtext, .questiontext, .formulation')?.innerText?.trim() || ''

        const opts = []
        el.querySelectorAll('.answer div.r0, .answer div.r1, .answer label').forEach(o => {
          const oc = o.cloneNode(true)
          oc.querySelectorAll('input, .answernumber').forEach(e => e.remove())
          const t = oc.innerText?.trim()
          if (t && t.length > 0 && !t.match(/^[a-d]\.?$/i)) opts.push(t)
        })

        return questionText.length > 5 ? { questionText, options: opts, index: si + idx } : null
      }).filter(Boolean)
    }, qi)

    questions.push(...pqs)
    qi += pqs.length

    const nextBtn = await page.$('input[name="next"], .mod_quiz-next-nav')
    if (nextBtn && pqs.length > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
        nextBtn.click()
      ])
      // Wait for next page questions to load
      try {
        await page.waitForSelector('.que', { timeout: 8000 })
      } catch (_) {}
    } else {
      hasNext = false
    }
  }

  return questions
}

async function getCourseFromDB(courseCode) {
  const { data } = await supabase
    .from('courses')
    .select('id, shared_material_code, course_code')
    .or(`course_code.ilike.%${courseCode}%,course_code.ilike.%${courseCode.replace(/([A-Z]+)(\d+)/, '$1 $2')}%`)
    .limit(1)
    .single()
  return data
}

async function getAnswerForQuestion(questionText, options, materialCode, courseId) {
  // Check question bank first
  if (courseId) {
    const { data: bank } = await supabase
      .from('question_bank')
      .select('answer_text')
      .eq('course_id', courseId)
      .ilike('question_text', `%${questionText.slice(0, 60)}%`)
      .limit(1)
      .single()
    if (bank) return { answer: bank.answer_text, source: 'question_bank' }
  }

  // Sliding window material search
  const words = questionText.replace(/[^a-zA-Z\s]/g, ' ').split(' ').filter(w => w.length > 2)
  const phrases = [...words]
  for (let i = 0; i < words.length - 1; i++) phrases.push(`${words[i]} ${words[i+1]}`)
  for (let i = 0; i < words.length - 2; i++) phrases.push(`${words[i]} ${words[i+1]} ${words[i+2]}`)

  const chunkSet = new Set()
  for (const phrase of phrases.slice(0, 15)) {
    if (chunkSet.size >= 4) break
    const { data: matched } = await supabase
      .from('shared_material_chunks')
      .select('chunk_text')
      .eq('course_code', materialCode)
      .ilike('chunk_text', `%${phrase}%`)
      .limit(2)
    if (matched?.length) matched.forEach(m => chunkSet.add(m.chunk_text))
  }

  const materialContext = Array.from(chunkSet).join('\n\n---\n\n')
  const hasMaterial = materialContext.length > 0
  const optionsText = options.map((o, i) => `${String.fromCharCode(65+i)}. ${o}`).join('\n')

  const result = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{
      role: 'user',
      content: `You are a NOUN TMA assistant.
${hasMaterial ? `COURSE MATERIAL:\n${materialContext}\n\n` : ''}
QUESTION: "${questionText}"
${optionsText ? `OPTIONS:\n${optionsText}` : ''}

RULES:
1. Find the answer in the course material
2. For fill-in-blank find the sentence with those words completed
3. Match to the closest option
4. Reply ONLY with the letter and option text e.g "B. Success"
5. If not found reply: ANSWER_NOT_FOUND`
    }],
    max_tokens: 256
  })

  const answer = result.choices[0]?.message?.content?.trim() || 'ANSWER_NOT_FOUND'
  return {
    answer: answer === 'ANSWER_NOT_FOUND' ? '' : answer,
    source: answer === 'ANSWER_NOT_FOUND' ? 'not_found' : (hasMaterial ? 'course_material' : 'internet')
  }
}

async function log(runId, message) {
  console.log(message)
  try {
    await supabase.rpc('append_run_log', { p_run_id: runId, p_message: message })
  } catch (e) {}
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'NOUN Scraper running' })
})

app.post('/scrape-tma', async (req, res) => {
  const { matric, password, secret, tma_round } = req.body
  if (secret !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!matric || !password) return res.status(400).json({ error: 'Matric and password required' })

  const roundNumber = tma_round?.replace('TMA', '') || '1'
  let browser = null

  try {
    browser = await launchBrowser()
    const page = await setupPage(browser)

    const loggedIn = await loginToNOUN(page, matric, password)
    if (!loggedIn) {
      await browser.close()
      return res.status(401).json({ error: 'Invalid NOUN credentials.' })
    }

    const { quizLinks } = await findTMALinks(page, roundNumber)

    if (quizLinks.length === 0) {
      await browser.close()
      return res.json({ success: true, quizzes: [], message: `No TMA${roundNumber} found` })
    }

    const results = []

    for (const quiz of quizLinks) {
      try {
        await page.goto(quiz.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
        const courseCode = await page.evaluate(() => {
          const b = document.querySelector('.breadcrumb')?.innerText || document.title || ''
          const m = b.match(/([A-Z]{2,4}\s*\d{3})/i)
          return m ? m[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
        })
        await navigateToAttempt(page, null)
        const questions = await scrapeQuestions(page)
        if (questions.length > 0) {
          results.push({ title: quiz.text, course_code: courseCode, url: quiz.href, questions })
        }
      } catch (e) {
        console.error('Quiz error:', e.message)
      }
    }

    await browser.close()
    return res.json({ success: true, quizzes: results })

  } catch (err) {
    if (browser) try { await browser.close() } catch (_) {}
    return res.status(500).json({ error: 'Scraping failed: ' + err.message })
  }
})

app.post('/run-full-tma', async (req, res) => {
  const { matric, password, secret, tma_round, run_id, user_id } = req.body
  if (secret !== SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' })

  if (isRunning) {
    // Update DB to failed so frontend stops polling
    await supabase.from('vip_runs')
      .update({ status: 'failed', error_message: 'Another TMA is already running. Please wait 2 minutes and try again.' })
      .eq('id', run_id)
    return res.status(429).json({ error: 'Already running' })
  }

  console.log('run-full-tma called, run_id:', run_id)
  res.json({ status: 'started', run_id })
  runFullTMA(matric, password, tma_round, run_id, user_id)
})

// ─── Full TMA Runner ─────────────────────────────────────────────────────────

async function runFullTMA(matric, password, tmaRound, runId, userId) {
  isRunning = true
  let browser = null
  
  // Hard timeout — force cleanup after 8 minutes
  const hardTimeout = setTimeout(async () => {
    console.log('Hard timeout reached — forcing cleanup')
    if (browser) try { await browser.close() } catch (_) {}
    isRunning = false
    await supabase.from('vip_runs').update({
      status: 'failed', error_message: 'Timed out. Please try again.'
    }).eq('id', runId)
    await supabase.rpc('credit_token_wallet', { p_user_id: userId, p_amount: 1 })
  }, 480000)

  try {
    await supabase.from('vip_runs').update({ status: 'running' }).eq('id', runId)
    await log(runId, 'Logging into NOUN portal...')

    browser = await launchBrowser()
    const page = await setupPage(browser)

    const loggedIn = await loginToNOUN(page, matric, password)
    if (!loggedIn) {
      await browser.close()
      await log(runId, 'Invalid NOUN credentials')
      await supabase.from('vip_runs').update({
        status: 'failed', error_message: 'Invalid credentials'
      }).eq('id', runId)
      return
    }

    await log(runId, 'Login successful')

    const roundNumber = tmaRound.replace('TMA', '')
    await log(runId, 'Loading courses...')

    const { quizLinks, totalCourses } = await findTMALinks(page, roundNumber)

    await log(runId, `Found ${totalCourses} courses, ${quizLinks.length} have ${tmaRound} open`)

    if (quizLinks.length === 0) {
      await browser.close()
      await supabase.from('vip_runs').update({
        status: 'failed',
        error_message: `No ${tmaRound} found. Make sure your TMA is open on the NOUN portal.`
      }).eq('id', runId)
      return
    }

    // Check if this is a re-run (same matric + round completed before)
    const { data: previousRun } = await supabase
      .from('vip_runs')
      .select('id')
      .eq('noun_matric', matric.toUpperCase())
      .eq('tma_round', tmaRound)
      .eq('status', 'completed')
      .neq('id', runId)
      .limit(1)
      .single()

    if (previousRun) {
      await log(runId, 'Re-run detected — no token charged')
    } else {
      await supabase.rpc('debit_token_wallet', { p_user_id: userId, p_amount: 1 })
      await supabase.from('token_transactions').insert({
        user_id: userId, type: 'debit', amount: 1,
        description: `Used 1 token for ${tmaRound}`, status: 'success'
      })
      await log(runId, 'Token deducted')
    }

    await log(runId, 'AI is answering questions...')

    const allResults = []

    for (const quiz of quizLinks) {
      try {
        await page.goto(quiz.href, { waitUntil: 'domcontentloaded', timeout: 30000 })

        const detectedCode = await page.evaluate(() => {
          const b = document.querySelector('.breadcrumb')?.innerText || document.title || ''
          const m = b.match(/([A-Z]{2,4}\s*\d{3})/i)
          return m ? m[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
        })

        await navigateToAttempt(page, runId)
        const questions = await scrapeQuestions(page)

        await log(runId, `${detectedCode}: ${questions.length} questions found`)

        const course = await getCourseFromDB(detectedCode)
        const materialCode = course?.shared_material_code || detectedCode

        for (const q of questions.slice(0, 10)) {
          try {
            const { answer, source } = await getAnswerForQuestion(
              q.questionText, q.options, materialCode, course?.id
            )

            // Save to question bank if from material
            if (source === 'course_material' && course?.id && answer) {
              const { data: existing } = await supabase
                .from('question_bank')
                .select('id')
                .eq('course_id', course.id)
                .ilike('question_text', `%${q.questionText.slice(0, 80)}%`)
                .single()

              if (!existing) {
                const { error: qbErr } = await supabase.from('question_bank').insert({
                  course_id: course.id,
                  question_text: q.questionText,
                  answer_text: answer,
                  source: 'course_material',
                  contributed_by: userId
                })
                if (qbErr) console.log('QB error:', qbErr.message)
              }
            }

            allResults.push({
              courseCode: detectedCode,
              courseTitle: quiz.text.replace(/Course is starred[\s\S]*?(?=[A-Z])/g, '').trim(),
              questionNumber: q.index,
              question: q.questionText,
              options: q.options,
              answer,
              source
            })
          } catch (groqErr) {
            console.error('Groq error:', groqErr.message)
            allResults.push({
              courseCode: detectedCode,
              courseTitle: quiz.text,
              questionNumber: q.index,
              question: q.questionText,
              options: q.options,
              answer: '',
              source: 'not_found'
            })
          }
        }
      } catch (quizErr) {
        await log(runId, `Error on ${quiz.text}: ${quizErr.message}`)
      }
    }

  await browser.close()
    isRunning = false
    clearTimeout(hardTimeout)
    await log(runId, `Done! ${allResults.length} questions answered`)
    await supabase.from('vip_runs').update({
      status: 'completed',
      results: allResults,
      completed_at: new Date().toISOString()
    }).eq('id', runId)

  } catch (err) {
    clearTimeout(hardTimeout)
    isRunning = false
    console.error('Full TMA error:', err)
    if (browser) try { await browser.close() } catch (_) {}
    await supabase.from('vip_runs').update({
      status: 'failed', error_message: err.message
    }).eq('id', runId)
    await supabase.rpc('credit_token_wallet', { p_user_id: userId, p_amount: 1 })
  }
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`NOUN Scraper running on port ${PORT}`)
})