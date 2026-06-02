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
        '--js-flags=--max-old-space-size=256'
      ]
    })

    const page = await browser.newPage()

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

    await page.goto('https://elearn.nou.edu.ng/my/', {
      waitUntil: 'networkidle0',
      timeout: 45000
    })

const quizLinks = await page.evaluate((roundNum) => {
  const links = Array.from(document.querySelectorAll('a[href*="/mod/quiz/"]'))
  return links
    .map(a => ({ href: a.href, text: a.innerText.trim() }))
    .filter(l => {
      const text = l.text.toLowerCase().trim()
      // Must contain tma or tutor marked
      const isTMA = text.includes('tma') || text.includes('tutor marked')
      // Must match EXACT round — "tma1" not "tma12" or "tma2"
      const exactRound = new RegExp(`tma\\s*${roundNum}(\\b|\\s|$)`, 'i').test(text) ||
        new RegExp(`tutor marked assignment\\s*${roundNum}(\\b|\\s|$)`, 'i').test(text)
      return isTMA && exactRound
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

        let currentUrl = page.url()
        console.log('Quiz URL:', currentUrl)

        // Extract course code
        const courseCode = await page.evaluate(() => {
          const breadcrumb = document.querySelector('.breadcrumb, nav[aria-label] ol')
          const text = breadcrumb?.innerText || document.title || ''
          const match = text.match(/([A-Z]{2,4}\s*\d{3})/i)
          return match ? match[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
        })

        console.log('Course code:', courseCode)

        // If already on attempt page skip clicking
        if (!currentUrl.includes('attempt.php')) {
          // Try start attempt button
          const attemptBtn = await page.$('input[name="startattempt"]')
          if (attemptBtn) {
            console.log('Clicking start attempt...')
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
              attemptBtn.click()
            ])
            currentUrl = page.url()
            console.log('After start click:', currentUrl)
          }

          // Confirmation page
          if (!currentUrl.includes('attempt.php')) {
            const confirmBtn = await page.$('button[type="submit"], input[type="submit"]')
            if (confirmBtn) {
              console.log('Clicking confirm...')
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                confirmBtn.click()
              ])
              currentUrl = page.url()
              console.log('After confirm:', currentUrl)
            }
          }

          // Try continue last attempt link
          if (!currentUrl.includes('attempt.php')) {
            const continueLink = await page.$('a[href*="attempt.php"]')
            if (continueLink) {
              const href = await page.evaluate(el => el.href, continueLink)
              console.log('Continuing existing attempt:', href)
              await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 })
              currentUrl = page.url()
            }
          }
        }

        console.log('Final URL:', currentUrl)

        // Wait for questions
        try {
          await page.waitForSelector('.que', { timeout: 8000 })
        } catch (_) {
          console.log('No .que found, trying alternatives...')
        }

        // Log page structure for debugging
        const pageInfo = await page.evaluate(() => {
          return {
            title: document.title,
            queCount: document.querySelectorAll('.que').length,
            qtextCount: document.querySelectorAll('.qtext').length,
            formCount: document.querySelectorAll('form').length,
            bodySnippet: document.body.innerText.slice(0, 300)
          }
        })
        console.log('Page info:', JSON.stringify(pageInfo))

        // Scrape questions
        const questions = []
        let hasNextPage = true
        let questionIndex = 1

        while (hasNextPage) {
          const pageQuestions = await page.evaluate((startIndex) => {
            const qEls = document.querySelectorAll('.que')
            const qs = []

qEls.forEach((el) => {
  // Clone and remove unwanted elements first
  const clone = el.cloneNode(true)
  
  // Remove answer options, buttons, and noise
  clone.querySelectorAll('.answer, .outcome, .comment, .gradingdetails, input, button, .clearfix').forEach(e => e.remove())
  
  const qTextEl = clone.querySelector('.qtext, .questiontext, .formulation')
  const questionText = qTextEl?.innerText?.trim() || ''

  // Get options from ORIGINAL element (not clone)
  const answerDiv = el.querySelector('.answer')
  const options = []

  if (answerDiv) {
    const optEls = answerDiv.querySelectorAll('div.r0, div.r1, label')
    optEls.forEach(opt => {
      const optClone = opt.cloneNode(true)
      optClone.querySelectorAll('input, .answernumber').forEach(e => e.remove())
      const text = optClone.innerText?.trim()
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

          console.log(`Found ${pageQuestions.length} questions on this page`)
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

        console.log(`${courseCode}: ${questions.length} total questions`)

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

const { createClient } = require('@supabase/supabase-js')
const Groq = require('groq-sdk')
const ws = require('ws')

// Add at top after requires
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    realtime: {
      transport: ws
    }
  }
)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

app.post('/run-full-tma', async (req, res) => {
  const { matric, password, secret, tma_round, run_id, user_id } = req.body

  if (secret !== SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Respond immediately — work happens in background
  res.json({ status: 'started', run_id })

  // Now do all the heavy work
  runFullTMA(matric, password, tma_round, run_id, user_id)
})

async function log(runId, message) {
  console.log(message)
  try {
    await supabase.rpc('append_run_log', { p_run_id: runId, p_message: message })
  } catch (e) {}
}

async function runFullTMA(matric, password, tmaRound, runId, userId) {
  let browser = null
  try {
    await supabase.from('vip_runs').update({ status: 'running' }).eq('id', runId)
    await log(runId, '🔄 Logging into NOUN portal...')

    // Launch browser and scrape (same code as /scrape-tma)
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-gpu', '--single-process', '--js-flags=--max-old-space-size=256']
    })

    const page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', r => {
      if (['image','stylesheet','font','media'].includes(r.resourceType())) r.abort()
      else r.continue()
    })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')

    await page.goto('https://elearn.nou.edu.ng/login/index.php', {
      waitUntil: 'domcontentloaded', timeout: 30000
    })
    await page.type('#username', matric, { delay: 50 })
    await page.type('#password', password, { delay: 50 })
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('#loginbtn')
    ])

    const loginError = await page.$('.loginerrors, .alert-danger')
    if (loginError) {
      await browser.close()
      await log(runId, '❌ Invalid NOUN credentials')
      await supabase.from('vip_runs').update({
        status: 'failed', error_message: 'Invalid credentials'
      }).eq('id', runId)
      return
    }

    await log(runId, '✅ Login successful')

    const roundNumber = tmaRound.replace('TMA', '')
    await page.goto('https://elearn.nou.edu.ng/my/', {
      waitUntil: 'networkidle0', timeout: 45000
    })

    const quizLinks = await page.evaluate((rn) => {
      return Array.from(document.querySelectorAll('a[href*="/mod/quiz/"]'))
        .map(a => ({ href: a.href, text: a.innerText.trim() }))
        .filter(l => {
          const t = l.text.toLowerCase()
          return (t.includes('tma') || t.includes('tutor marked')) &&
            new RegExp(`tma\\s*${rn}(\\b|\\s|$)`, 'i').test(t)
        })
        .slice(0, 30)
    }, roundNumber)

    await log(runId, `📚 Found ${quizLinks.length} ${tmaRound} link(s)`)

    if (quizLinks.length === 0) {
      await browser.close()
      await supabase.from('vip_runs').update({
        status: 'failed',
        error_message: `No ${tmaRound} found. Make sure TMA is open on NOUN portal.`
      }).eq('id', runId)
      return
    }

    // Deduct token
    await supabase.rpc('debit_token_wallet', { p_user_id: userId, p_amount: 1 })
    await supabase.from('token_transactions').insert({
      user_id: userId, type: 'debit', amount: 1,
      description: `Used 1 token for ${tmaRound}`, status: 'success'
    })
    await log(runId, '🪙 Token deducted')

    const allResults = []

    for (const quiz of quizLinks) {
      const courseCode = quiz.course_code || 'UNKNOWN'
      
      try {
        await page.goto(quiz.href, { waitUntil: 'domcontentloaded', timeout: 30000 })

        const detectedCode = await page.evaluate(() => {
          const b = document.querySelector('.breadcrumb')?.innerText || document.title
          const m = b.match(/([A-Z]{2,4}\s*\d{3})/i)
          return m ? m[1].replace(/\s+/g, '').toUpperCase() : 'UNKNOWN'
        })

        await log(runId, `📖 Scraping ${detectedCode}...`)

        if (!page.url().includes('attempt.php')) {
          const btn = await page.$('input[name="startattempt"]')
          if (btn) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
              btn.click()
            ])
            const confirm = await page.$('button[type="submit"]')
            if (confirm && !page.url().includes('attempt.php')) {
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                confirm.click()
              ])
            }
          }
        }

        try { await page.waitForSelector('.que', { timeout: 8000 }) } catch (_) {}

        const questions = []
        let hasNext = true
        let qi = 1

        while (hasNext) {
          const pqs = await page.evaluate((si) => {
            return Array.from(document.querySelectorAll('.que')).map(el => {
              const clone = el.cloneNode(true)
              clone.querySelectorAll('.answer, .outcome, input, button').forEach(e => e.remove())
              const qt = clone.querySelector('.qtext, .questiontext, .formulation')?.innerText?.trim() || ''
              const opts = []
              el.querySelectorAll('.answer div.r0, .answer div.r1, .answer label').forEach(o => {
                const oc = o.cloneNode(true)
                oc.querySelectorAll('input, .answernumber').forEach(e => e.remove())
                const t = oc.innerText?.trim()
                if (t && t.length > 0 && !t.match(/^[a-d]\.?$/i)) opts.push(t)
              })
              return qt.length > 5 ? { questionText: qt, options: opts, index: si++ } : null
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
          } else {
            hasNext = false
          }
        }

        await log(runId, `✅ ${detectedCode}: ${questions.length} questions found`)

        // Get course from Supabase
        const { data: course } = await supabase
          .from('courses')
          .select('id, shared_material_code, course_code')
          .ilike('course_code', `%${detectedCode}%`)
          .limit(1).single()

        const materialCode = course?.shared_material_code || detectedCode

        // Answer each question
        for (const q of questions.slice(0, 10)) {
          // Check question bank
          let bankHit = null
          if (course?.id) {
            const { data: bank } = await supabase
              .from('question_bank')
              .select('id, question_text, answer_text')
              .eq('course_id', course.id)
              .ilike('question_text', `%${q.questionText.slice(0, 60)}%`)
              .limit(1).single()
            if (bank) bankHit = bank
          }

          if (bankHit) {
            allResults.push({
              courseCode: detectedCode,
              courseTitle: quiz.text,
              questionNumber: q.index,
              question: q.questionText,
              options: q.options,
              answer: bankHit.answer_text,
              source: 'question_bank'
            })
            continue
          }

          // Search material chunks
          const chunks = []
          const words = q.questionText.replace(/[^a-zA-Z\s]/g, ' ').split(' ').filter(w => w.length > 2)
          const phrases = [...words]
          for (let i = 0; i < words.length - 1; i++) phrases.push(`${words[i]} ${words[i+1]}`)

          for (const phrase of phrases.slice(0, 10)) {
            if (chunks.length >= 4) break
            const { data: matched } = await supabase
              .from('shared_material_chunks')
              .select('chunk_text')
              .eq('course_code', materialCode)
              .ilike('chunk_text', `%${phrase}%`)
              .limit(2)
            if (matched?.length) chunks.push(...matched.map(m => m.chunk_text))
          }

          const materialContext = [...new Set(chunks)].join('\n\n---\n\n')
          const hasMaterial = materialContext.length > 0
          const optionsText = q.options.map((o, i) => `${String.fromCharCode(65+i)}. ${o}`).join('\n')

          try {
            const result = await groq.chat.completions.create({
              model: 'llama-3.3-70b-versatile',
              messages: [{
                role: 'user',
                content: `You are a NOUN TMA assistant.
${hasMaterial ? `COURSE MATERIAL:\n${materialContext}\n\n` : ''}
QUESTION: "${q.questionText}"
${optionsText ? `OPTIONS:\n${optionsText}` : ''}

RULES:
1. Find answer in material
2. For fill-in-blank find sentence with those words completed
3. Match to closest option
4. Reply ONLY with letter and text e.g "B. Success"
5. If not found reply: ANSWER_NOT_FOUND`
              }],
              max_tokens: 256
            })

            const answer = result.choices[0]?.message?.content?.trim() || 'ANSWER_NOT_FOUND'

            if (answer !== 'ANSWER_NOT_FOUND' && course?.id) {
              await supabase.from('question_bank').insert({
                course_id: course.id,
                question_text: q.questionText,
                answer_text: answer,
                source: 'course_material',
                contributed_by: userId
              }).catch(() => {})
            }

            allResults.push({
              courseCode: detectedCode,
              courseTitle: quiz.text,
              questionNumber: q.index,
              question: q.questionText,
              options: q.options,
              answer: answer === 'ANSWER_NOT_FOUND' ? '' : answer,
              source: answer === 'ANSWER_NOT_FOUND' ? 'not_found' : (hasMaterial ? 'course_material' : 'internet')
            })
          } catch (groqErr) {
            console.error('Groq error:', groqErr.message)
            allResults.push({
              courseCode: detectedCode, courseTitle: quiz.text,
              questionNumber: q.index, question: q.questionText,
              options: q.options, answer: '', source: 'not_found'
            })
          }
        }

      } catch (quizErr) {
        await log(runId, `⚠️ Error on ${quiz.text}: ${quizErr.message}`)
      }
    }

    await browser.close()
    await log(runId, `🎉 Done! ${allResults.length} questions answered`)

    await supabase.from('vip_runs').update({
      status: 'completed',
      results: allResults,
      completed_at: new Date().toISOString()
    }).eq('id', runId)

  } catch (err) {
    console.error('Full TMA error:', err)
    if (browser) try { await browser.close() } catch (_) {}
    await supabase.from('vip_runs').update({
      status: 'failed', error_message: err.message
    }).eq('id', runId)
    // Refund token
    await supabase.rpc('credit_token_wallet', { p_user_id: userId, p_amount: 1 })
  }
}