const express = require("express");
const { chromium } = require("playwright");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Groq = require("groq-sdk");
const ws = require("ws");

const app = express();
app.use(express.json());
app.use(cors());

const SECRET_KEY =
  process.env.SCRAPER_SECRET || "noun-tma-secret-2024-olakunle";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { realtime: { transport: ws } },
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
let isRunning = false;

async function enterQuizMinimal(page) {
  try {
    // If already in an attempt, navigate away to reset
    if (page.url().includes("attempt.php")) {
      console.log("Already in attempt, navigating away to reset...");
      await page.goto(
        page.url().split("/mod/quiz/")[0] +
          "/mod/quiz/view.php?id=" +
          new URL(page.url()).searchParams.get("cmid"),
        {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        },
      );
      await page.waitForTimeout(1500);
    }

    // Now click start attempt
    const startBtn = await page.$('input[name="startattempt"]');
    if (startBtn) {
      await startBtn.click();
      await page.waitForTimeout(4000);
      console.log("Clicked start attempt");
    }
  } catch (e) {
    console.log("enterQuizMinimal error:", e.message);
  }

  // Navigate to page 0
  try {
    if (page.url().includes("attempt.php")) {
      const baseUrl = page.url().split("&page=")[0];
      await page.goto(`${baseUrl}&page=0`, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await page.waitForTimeout(1000);
      console.log("At page 0, URL:", page.url());
    }
  } catch (e) {
    console.log("Could not navigate to page 0:", e.message);
  }
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function setupPage(browser) {
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    viewport: { width: 1280, height: 800 },
  });

  // Block images, stylesheets, fonts, media
  await page.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return page;
}

async function loginToNOUN(page, matric, password) {
  await page.goto("https://elearn.nou.edu.ng/login/index.php", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  console.log("Received matric:", `"${matric}"`, "password:", `"${password}"`);

  console.log("On login page, current URL:", page.url());

  // Check if selectors exist
  const usernameField = await page.$("#username");
  const passwordField = await page.$("#password");
  const loginButton = await page.$("#loginbtn");
  console.log("Username field exists:", !!usernameField);
  console.log("Password field exists:", !!passwordField);
  console.log("Login button exists:", !!loginButton);

  if (!usernameField || !passwordField || !loginButton) {
    console.log("ERROR: Login form selectors not found!");
    return false;
  }

  // Use Playwright's fill() instead of evaluate()
  await page.fill("#username", matric);
  await page.fill("#password", password);

  console.log("Credentials filled via Playwright");
  await page.waitForTimeout(1000);

  await page.click("#loginbtn");
  console.log("Login button clicked");

  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  console.log("After login, URL:", finalUrl);

  const loginFailed = finalUrl.includes("login/index.php");
  console.log("Login failed (still on login page):", loginFailed);

  return !loginFailed;
}

async function findTMALinks(page, roundNumber) {
  await page.goto("https://elearn.nou.edu.ng/my/courses.php", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 800));
  }

  try {
    await page.waitForSelector('a[href*="/course/view"]', { timeout: 10000 });
  } catch (_) {}

  const courseLinks = await page.evaluate(() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/course/view"]'))
      .map((a) => ({ href: a.href.split("#")[0], text: a.innerText.trim() }))
      .filter((l) => {
        if (!l.text || l.text.length < 2 || seen.has(l.href)) return false;
        seen.add(l.href);
        return true;
      });
  });

  console.log(`Found ${courseLinks.length} course links`);
  const quizLinks = [];

  for (const course of courseLinks) {
    try {
      await page.goto(course.href, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await new Promise((r) => setTimeout(r, 1500));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 500));

      const found = await page.evaluate((roundNum) => {
        return Array.from(document.querySelectorAll("a"))
          .map((a) => ({ href: a.href, text: a.innerText.trim() }))
          .filter((l) => {
            if (!l.href.includes("/mod/quiz/")) return false;
            const text = l.text.toLowerCase();
            const isTMA = text.includes("tma") || text.includes("tutor marked");
            const exactRound =
              new RegExp(`tma\\s*${roundNum}(\\b|\\s|$)`, "i").test(text) ||
              new RegExp(
                `tutor marked assignment\\s*${roundNum}(\\b|\\s|$)`,
                "i",
              ).test(text);
            return isTMA && exactRound;
          });
      }, roundNumber);

      if (found.length > 0) {
        console.log(
          `Found TMA${roundNumber} in ${course.text}: ${found.length} link(s)`,
        );
        quizLinks.push(...found);
      }
    } catch (e) {
      console.log("Error checking course:", course.text, e.message);
    }
  }

  return { quizLinks, totalCourses: courseLinks.length };
}

// Helper to clean answer text
function cleanAnswer(answer) {
  if (!answer) return answer;
  return answer.replace(/^[A-Da-d]\.\s*/, "").trim();
}

async function scrapeQuestions(page) {
  console.log("scrapeQuestions called, URL:", page.url());

  await new Promise((r) => setTimeout(r, 1000));

  const queCount = await page.evaluate(
    () => document.querySelectorAll(".que").length,
  );
  console.log(`Found ${queCount} .que elements`);

  if (queCount === 0) {
    console.log("No questions found on page");
    return [];
  }

  const questions = [];
  let hasNext = true;
  let qi = 1;

  while (hasNext) {
    const pqs = await page.evaluate((si) => {
      const qEls = document.querySelectorAll(".que");
      const qs = [];

      qEls.forEach((el, idx) => {
        let questionText =
          el
            .querySelector(".qtext, .questiontext, .formulation")
            ?.innerText?.trim() || "";

        if (!questionText) {
          const clone = el.cloneNode(true);
          clone.querySelector(".info")?.remove();
          clone
            .querySelectorAll("input, button, .answer, .outcome")
            .forEach((e) => e.remove());
          questionText = clone.innerText?.trim() || "";
        }

        const opts = [];
        el.querySelectorAll(
          'label[for*="answer"], .answer label, .answeroption label',
        ).forEach((label) => {
          const text = label.innerText?.trim();
          if (text) opts.push(text);
        });

        if (questionText) {
          qs.push({
            index: idx + 1,
            questionText,
            options: opts,
          });
        }
      });

      return qs;
    });

    if (pqs.length > 0) {
      console.log(`Page ${qi}: extracted ${pqs.length} questions`);
      questions.push(...pqs);
      qi++;
    }

    const nextBtn = await page.$(
      'input[name="next"], button[name="next"], a[href*="page=' + qi + '"]',
    );
    hasNext = !!nextBtn;

    if (hasNext) {
      if (nextBtn) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      }
    }
  }

  return questions;
}

async function getAnswerForQuestion(
  questionText,
  options,
  courseCode,
  courseId,
) {
  try {
    // Search course materials first
    const { data: materialChunks } = await supabase
      .from("shared_material_chunks")
      .select("chunk_text")
      .eq("course_code", courseCode)
      .limit(5);

    const { data: qbItems } = await supabase
      .from("question_bank")
      .select("answer_text")
      .eq("course_id", courseId)
      .ilike("question_text", `%${questionText.slice(0, 50)}%`)
      .limit(3);

    const foundChunks =
      materialChunks?.filter((c) =>
        c.chunk_text
          .toLowerCase()
          .includes(questionText.slice(0, 30).toLowerCase()),
      ) || [];

    if (qbItems && qbItems.length > 0) {
      return {
        answer: qbItems[0].answer_text || "",
        source: "question_bank",
        match_percentage: 99,
      };
    }

    if (foundChunks.length > 0) {
      const context = foundChunks.map((c) => c.chunk_text).join("\n\n");
      const prompt = `Given this course material:\n${context}\n\nAnswer this question: ${questionText}\n\nOptions: ${options.join(", ")}\n\nProvide only the best answer without explanation.`;

      const message = await groq.messages.create({
        model: "mixtral-8x7b-32768",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      });

      return {
        answer:
          message.content[0].type === "text" ? message.content[0].text : "",
        source: "course_material",
        match_percentage: Math.min(95, 60 + foundChunks.length * 5),
      };
    }

    // Fallback to Groq
    const prompt = `Answer this question: ${questionText}\n\nOptions: ${options.join(", ")}\n\nProvide only the best answer.`;
    const message = await groq.messages.create({
      model: "mixtral-8x7b-32768",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });

    return {
      answer: message.content[0].type === "text" ? message.content[0].text : "",
      source: "internet",
      match_percentage: 0,
    };
  } catch (err) {
    console.error("Answer error:", err.message);
    return { answer: "", source: "not_found", match_percentage: 0 };
  }
}

async function getCourseFromDB(courseCode) {
  const { data } = await supabase
    .from("courses")
    .select("id, shared_material_code")
    .eq("course_code", courseCode)
    .single();
  return data;
}

async function log(runId, message) {
  console.log(message);
  try {
    await supabase
      .from("vip_runs")
      .update({
        status_log: message,
      })
      .eq("id", runId);
  } catch (e) {
    console.error("Log error:", e.message);
  }
}

app.post("/run-full-tma", async (req, res) => {
  const { matric, password, secret, tma_round, run_id, user_id } = req.body;
  if (secret !== SECRET_KEY)
    return res.status(401).json({ error: "Unauthorized" });

  if (isRunning) {
    await supabase
      .from("vip_runs")
      .update({
        status: "failed",
        error_message: "Another TMA is running. Wait 2 minutes and try again.",
      })
      .eq("id", run_id);
    return res.status(429).json({ error: "Already running" });
  }

  console.log("run-full-tma called, run_id:", run_id);
  res.json({ status: "started", run_id });
  runFullTMA(matric, password, tma_round, run_id, user_id);
});

async function runFullTMA(matric, password, tmaRound, runId, userId) {
  isRunning = true;
  let browser = null;
  let tokenDeducted = false;

  const hardTimeout = setTimeout(async () => {
    console.log("Hard timeout reached — forcing cleanup");
    if (browser)
      try {
        await browser.close();
      } catch (_) {}
    isRunning = false;
    await supabase
      .from("vip_runs")
      .update({
        status: "failed",
        error_message: "Timed out. Please try again.",
      })
      .eq("id", runId);
    if (tokenDeducted) {
      await supabase.rpc("credit_token_wallet", {
        p_user_id: userId,
        p_amount: 1,
      });
    }
  }, 1200000); // 20 minutes

  try {
    await supabase
      .from("vip_runs")
      .update({ status: "running" })
      .eq("id", runId);
    await log(runId, "Logging into NOUN portal...");

    browser = await launchBrowser();
    const page = await setupPage(browser);

    const loggedIn = await loginToNOUN(page, matric, password);
    if (!loggedIn) {
      await browser.close();
      isRunning = false;
      clearTimeout(hardTimeout);
      await log(runId, "Invalid NOUN credentials");
      await supabase
        .from("vip_runs")
        .update({ status: "failed", error_message: "Invalid credentials" })
        .eq("id", runId);
      return;
    }

    await log(runId, "Login successful");

    const roundNumber = tmaRound.replace("TMA", "");
    await log(runId, "Loading courses...");

    const { quizLinks, totalCourses } = await findTMALinks(page, roundNumber);
    await log(
      runId,
      `Found ${totalCourses} courses, ${quizLinks.length} have ${tmaRound} open`,
    );

    if (quizLinks.length === 0) {
      await browser.close();
      isRunning = false;
      clearTimeout(hardTimeout);
      await supabase
        .from("vip_runs")
        .update({
          status: "failed",
          error_message: `No ${tmaRound} found. Make sure your TMA is open on the NOUN portal.`,
        })
        .eq("id", runId);
      return;
    }

    const { data: previousRun } = await supabase
      .from("vip_runs")
      .select("id")
      .eq("noun_matric", matric.toUpperCase())
      .eq("tma_round", tmaRound)
      .eq("status", "completed")
      .neq("id", runId)
      .limit(1)
      .single();

    if (previousRun) {
      await log(runId, "Re-run detected — no token charged");
    } else {
      await supabase.rpc("debit_token_wallet", {
        p_user_id: userId,
        p_amount: 1,
      });
      await supabase.from("token_transactions").insert({
        user_id: userId,
        type: "debit",
        amount: 1,
        description: `Used 1 token for ${tmaRound}`,
        status: "success",
      });
      await log(runId, "Token deducted");
      tokenDeducted = true;
    }

    await log(runId, "Scraping and answering questions...");
    const allResults = [];

    for (const quiz of quizLinks) {
      try {
        await page.goto(quiz.href, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(2000);

        await enterQuizMinimal(page);
        await page.waitForTimeout(2000);

        const detectedCode = await page.evaluate(() => {
          const b =
            document.querySelector(".breadcrumb")?.innerText ||
            document.title ||
            "";
          const m = b.match(/([A-Z]{2,4}\s*\d{3})/i);
          return m ? m[1].replace(/\s+/g, "").toUpperCase() : "UNKNOWN";
        });

        const questions = await scrapeQuestions(page);
        await log(
          runId,
          `${detectedCode}: ${questions.length} questions found`,
        );

        const course = await getCourseFromDB(detectedCode);
        const materialCode = course?.shared_material_code || detectedCode;

        for (const q of questions) {
          try {
            const { answer, source } = await getAnswerForQuestion(
              q.questionText,
              q.options,
              materialCode,
              course?.id,
            );

            if (source === "course_material" && course?.id && answer) {
              const { data: existing } = await supabase
                .from("question_bank")
                .select("id")
                .eq("course_id", course.id)
                .ilike("question_text", `%${q.questionText.slice(0, 80)}%`)
                .single()
                .catch(() => ({ data: null }));

              if (!existing) {
                await supabase.from("question_bank").insert({
                  course_id: course.id,
                  question_text: q.questionText,
                  answer_text: cleanAnswer(answer),
                  source: "course_material",
                  contributed_by: userId,
                });
              }
            }

            allResults.push({
              courseCode: detectedCode,
              courseTitle: quiz.text
                .replace(/Course is starred[\s\S]*?(?=[A-Z])/g, "")
                .trim(),
              questionNumber: q.index,
              question: q.questionText,
              options: q.options,
              answer: answer,
              answerText: cleanAnswer(answer),
              source,
            });
          } catch (groqErr) {
            console.error("Groq error:", groqErr.message);
            allResults.push({
              courseCode: detectedCode,
              courseTitle: quiz.text,
              questionNumber: q.index,
              question: q.questionText,
              options: q.options,
              answer: "",
              source: "not_found",
            });
          }
        }
      } catch (quizErr) {
        await log(runId, `Error on ${quiz.text}: ${quizErr.message}`);
      }
    }

    await browser.close();
    isRunning = false;
    clearTimeout(hardTimeout);
    await log(runId, `Done! ${allResults.length} questions answered`);
    await supabase
      .from("vip_runs")
      .update({
        status: "completed",
        results: allResults,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  } catch (err) {
    clearTimeout(hardTimeout);
    isRunning = false;
    console.error("Full TMA error:", err);
    if (browser)
      try {
        await browser.close();
      } catch (_) {}
    await supabase
      .from("vip_runs")
      .update({
        status: "failed",
        error_message: err.message,
      })
      .eq("id", runId);
    if (tokenDeducted) {
      await supabase.rpc("credit_token_wallet", {
        p_user_id: userId,
        p_amount: 1,
      });
    }
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`NOUN Scraper running on port ${PORT}`);
});
