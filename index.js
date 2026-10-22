require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors({origin: '*'}));
app.use(express.json());

// In-memory store for active student SAP sessions
// Structure: Map<sessionId, { browser, context, page, lastActive }>
const activeSessions = new Map();

/**
 * Helper: Finds the inner Web Dynpro content frame where data tables & forms render
 */
async function getWebDynproFrame(page) {
  await page.waitForTimeout(1500);
  const frames = page.frames();
  
  const wdFrame = frames.find(f => 
    f.name().includes('isolatedWorkArea') || 
    f.url().includes('webdynpro') || 
    f.url().includes(' sap-wd-')
  );
  
  if (wdFrame) return wdFrame;

  return page.frame({ name: /ivuFrm_page0ivu3|Desktop Inner Page/i }) || page.mainFrame();
}

/**
 * Selects an actual option from the SAP Web Dynpro combo popup so its
 * client-side selection events are raised.
 */
async function selectSapDropdown(page, wdFrame, labelText, optionValue) {
  const label = String(labelText || '').trim();
  const value = String(optionValue || '').trim();
  if (!label || !value) {
    throw new Error('A dropdown label and option value are required');
  }

  const targetIndex = label.toLowerCase().includes('year') ? 0 : 1;
  const combos = wdFrame.locator('input[ct="CB"]');
  const count = await combos.count();

  if (count <= targetIndex) {
    throw new Error(`Could not find the SAP ${label} dropdown`);
  }

  const combo = combos.nth(targetIndex);
  await combo.click();
  await wdFrame.waitForTimeout(250);

  // SAP popup layers can block normal pointer targeting; force the option click
  // while keeping the click targeted to the exact rendered option.
  for (const frame of page.frames()) {
    const options = frame.getByRole('option', { name: value, exact: true });
    const optionCount = await options.count();

    for (let index = 0; index < optionCount; index++) {
      const option = options.nth(index);
      if (await option.isVisible()) {
        await option.click({ force: true });
        await wdFrame.waitForTimeout(300);
        const selectedValue = (await combo.inputValue()).trim();
        if (selectedValue !== value) {
          throw new Error(`SAP ${label} dropdown did not select "${value}"`);
        }
        return;
      }
    }
  }

  throw new Error(`SAP ${label} option "${value}" was not available in the dropdown`);
}

/**
 * 1. LOGIN & FETCH ALL LIVE SERVICES
 * POST /api/login
 * Body: { "rollNo": "24052123", "password": "..." }
 */
app.post('/api/login', async (req, res) => {
  const { rollNo, password } = req.body;
  if (!rollNo || !password) {
    return res.status(400).json({ error: 'Roll number and password required' });
  }

  const browser = await chromium.launch({ headless: true }); // Set to true in production
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. Open SAP Portal Login
    await page.goto('https://kiitportal.kiituniversity.net/irj/portal', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // 2. Authenticate
    await page.fill('input[name="j_user"], #logonuidfield', rollNo);
    await page.fill('input[name="j_password"], #logonpassfield', password);
    await page.click('input[type="submit"], input[name="uidPasswordLogon"]');

    // Verify login succeeded
    await page.waitForSelector('#welcome_message', { timeout: 20000 });
    const welcomeBanner = await page.locator('#welcome_message').innerText();
    const studentName = welcomeBanner.replace(/Welcome|\./gi, '').trim();

    // 3. Click "Student Self Service" in Top Level Navigation (#navNodeAnchor_1_1)
    await page.locator('#navNodeAnchor_1_1').click();

    // 4. Wait for overview frame to load
    const innerFrame = page.frameLocator('#ivuFrm_page0ivu3');
    await innerFrame.getByText('Student Self Service').first().click().catch(() => {});
    await innerFrame.getByText('Student Attendance Details').first().waitFor({ state: 'visible', timeout: 20000 });

    // 5. Scrape live list of all available Student Self Services
    const liveServices = [];
    for (const frame of page.frames()) {
      const links = await frame.evaluate(() => {
        const ignoreList = ['Help', 'Log off', 'Back', 'Forward', 'History', 'Home', 'Overview', 'Student Self Service', 'Reload', 'AWARENESS IN CYBER SECURITY MANUAL'];
        return Array.from(document.querySelectorAll('a'))
          .map(a => {
            const title = a.innerText.trim();
            const parent = a.closest('td, div, li');
            let notice = null;
            if (parent) {
              const fullText = parent.innerText.trim();
              if (fullText.length > title.length + 5) {
                notice = fullText.replace(title, '').trim();
              }
            }
            return { title, notice };
          })
          .filter(item => item.title.length > 3 && !ignoreList.includes(item.title) && !item.title.includes('CSE -'));
      }).catch(() => []);
      liveServices.push(...links);
    }

    const serviceMap = new Map();
    for (const s of liveServices) {
      if (!serviceMap.has(s.title) || (s.notice && !serviceMap.get(s.title).notice)) {
        serviceMap.set(s.title, s);
      }
    }

    // 6. Store warm session
    const sessionId = randomUUID();
    activeSessions.set(sessionId, { browser, context, page, lastActive: Date.now() });

    return res.json({
      sessionId,
      studentName,
      rollNo,
      services: Array.from(serviceMap.values())
    });

  } catch (err) {
    await browser.close();
    return res.status(401).json({ error: 'Authentication or portal load failed', details: err.message });
  }
});

/**
 * 2. DYNAMIC SERVICE ROUTER (Handles clicking any of the 11 services)
 * POST /api/service
 * Body: { "sessionId": "...", "serviceTitle": "Student Attendance Details", "params": { "year": "2026-2027", "session": "Autumn" } }
 */
app.post('/api/service', async (req, res) => {
  const { sessionId, serviceTitle, params = {} } = req.body;

  if (!sessionId || !serviceTitle) {
    return res.status(400).json({ error: 'sessionId and serviceTitle are required' });
  }

  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(440).json({ error: 'Session expired. Please log in again.' });
  }

  const { page } = session;
  session.lastActive = Date.now();

  try {
    const innerFrame = page.frameLocator('#ivuFrm_page0ivu3');
    await innerFrame.getByText(serviceTitle, { exact: false }).first().click();

    await page.waitForTimeout(4000);
    let wdFrame = await getWebDynproFrame(page);

    if (params.year && params.session) {
      await selectSapDropdown(page, wdFrame, 'Year', params.year);
      await page.waitForTimeout(1000);
      wdFrame = await getWebDynproFrame(page);
      await selectSapDropdown(page, wdFrame, 'Session', params.session);
      await page.waitForTimeout(1000);

      const submitBtn = wdFrame.locator('button, span, div, a').filter({ hasText: /^Submit$/i }).first();
      await submitBtn.click().catch(() => page.keyboard.press('Enter'));

      await page.waitForTimeout(5000);
      wdFrame = await getWebDynproFrame(page);
    } else {
      await page.waitForTimeout(3000);
    }

    const viewData = await wdFrame.evaluate(() => {
      const normalizeText = (value) => (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      const metadata = {};
      const cells = Array.from(document.querySelectorAll('td, span, label'));
      for (let i = 0; i < cells.length - 1; i++) {
        const text = normalizeText(cells[i].innerText);
        if (text.endsWith(':') && text.length < 40) {
          const key = text.slice(0, -1).trim();
          const nextVal = normalizeText(cells[i + 1]?.innerText || '');
          if (key && nextVal && !nextVal.endsWith(':') && nextVal.length < 100) {
            metadata[key] = nextVal;
          }
        }
      }

      const cleanTables = [];
      const allTables = Array.from(document.querySelectorAll('table'));

      for (const table of allTables) {
        const rows = Array.from(table.querySelectorAll('tr'))
          .map(tr =>
            Array.from(tr.querySelectorAll('th, td'))
              .map(cell => normalizeText(cell.innerText).replace(/Row selection disabled\.|Column for row selection|Fill Feedback|Emphasized/gi, ''))
          )
          .filter(row => row.some(cell => cell.length > 0) && row.length >= 3);

        const hasSubjectCodes = rows.some(r => r.some(cell => /^[A-Z]{2,4}\d{3,5}$/.test(cell)));
        const hasAttendanceFields = rows.some(r => r.some(cell => /No\. of Absent|No\. of Present|Total Percentage|Faculty Name|No\. of Excuses|Total No\. of Days/i.test(cell)));

        if (rows.length >= 2 && (hasSubjectCodes || hasAttendanceFields)) {
          cleanTables.push(rows);
          break;
        }
      }

      const primaryTable = cleanTables[0] || [];
      const headers = primaryTable[0] || [];
      const dataRows = primaryTable.slice(1).map(row => {
        const rowObject = {};
        headers.forEach((header, index) => {
          rowObject[header || `column_${index + 1}`] = row[index] || '';
        });
        return rowObject;
      });

      return { metadata, tables: cleanTables, rows: dataRows };
    });

    return res.json({ serviceTitle, ...viewData });

  } catch (err) {
    return res.status(500).json({ error: `Failed to load ${serviceTitle}`, details: err.message });
  }
});

/**
 * 3. BACKLOG & GRADE IMPROVEMENT MANAGER (Fetch, Book & Unbook)
 * POST /api/backlog
 * Body: {
 *   "sessionId": "...",
 *   "action": "fetch" | "book" | "unbook",
 *   "subjectCode": "EC20005", // or "CS21001" for unbook
 *   "internalAssessment": false,
 *   "universityExam": true
 * }
 */
app.post('/api/backlog', async (req, res) => {
  const { sessionId, action = 'fetch', subjectCode, internalAssessment = false, universityExam = true } = req.body;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(440).json({ error: 'Session expired. Please log in again.' });
  }

  const { page } = session;
  session.lastActive = Date.now();

  try {
    // 1. Click "Backlog Booking" in the Left Sidebar
    const innerFrame = page.frameLocator('#ivuFrm_page0ivu3');
    await innerFrame.getByText('Backlog Booking', { exact: false }).first().click();
    await page.waitForTimeout(3500);

    const wdFrame = await getWebDynproFrame(page);

    // 2. Handle BOOK Action
    if (action === 'book' && subjectCode) {
      await wdFrame.evaluate(({ code, internal, uniExam }) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const targetRow = rows.find(tr => tr.innerText.includes(code));
        if (!targetRow) throw new Error(`Subject ${code} not found in Backlog Subject List`);

        // SAP Web Dynpro checkboxes use [role="checkbox"], [ct="CBX"], or input[type="checkbox"]
        const checkboxes = Array.from(
          targetRow.querySelectorAll('[role="checkbox"], [ct="CBX"], input[type="checkbox"], span.lsCBX--img')
        );

        // Column 0: Select | Column 1: Internal Assessment | Column 2: University Exam
        const toggleSapCheckbox = (el, shouldBeChecked) => {
          if (!el) return;
          const isChecked =
            el.getAttribute('aria-checked') === 'true' ||
            el.checked === true ||
            el.className.includes('checked') ||
            el.parentElement?.getAttribute('aria-checked') === 'true';
          if (isChecked !== shouldBeChecked) {
            el.click();
          }
        };

        toggleSapCheckbox(checkboxes[0], true);       // Check "Select"
        toggleSapCheckbox(checkboxes[1], internal);   // Set "Internal Assessment"
        toggleSapCheckbox(checkboxes[2], uniExam);    // Set "University Exam"
      }, { code: subjectCode, internal: internalAssessment, uniExam: universityExam });

      await page.waitForTimeout(800);

      // Click the green "Submit" button
      const submitBtn = wdFrame.locator('div[ct="B"], a[ct="B"], button, span').filter({ hasText: /Submit/i }).first();
      await submitBtn.click();
      await page.waitForTimeout(4000);
    }

    // 3. Handle UNBOOK Action
    let unbookStatus = null;
    if (action === 'unbook' && subjectCode) {
      unbookStatus = await wdFrame.evaluate((code) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const bookedRow = rows.find(tr => tr.innerText.includes(code));
        if (!bookedRow) {
          return { success: false, reason: `Subject ${code} not found in Booked Subject List.` };
        }

        // Look for any interactive unbook/delete/cancel button or checkbox inside the booked row or its table
        const actionBtn = bookedRow.querySelector(
          'a, button, [ct="B"], [role="button"], [role="checkbox"], input[type="checkbox"], img[title*="Delete" i], img[title*="Remove" i], img[title*="Cancel" i]'
        );

        if (actionBtn) {
          actionBtn.click();
          return { success: true, method: 'sap_portal_button', message: `Clicked unbook control for ${code}` };
        }

        // Check if there is a global "Unbook" / "Delete" / "Reset" button below the Booked Subject List table
        const allButtons = Array.from(document.querySelectorAll('[ct="B"], button, a.urBtnStd'));
        const globalUnbookBtn = allButtons.find(b => /(unbook|delete|remove|cancel|reset)/i.test(b.innerText));
        if (globalUnbookBtn) {
          bookedRow.click(); // Select row first
          globalUnbookBtn.click();
          return { success: true, method: 'sap_global_button', message: `Triggered global unbook for ${code}` };
        }

        return {
          success: false,
          sapLocked: true,
          reason: 'SAP locks Booked Subject List rows as read-only after submission. Use 1-Tap COE/Mentor Unbook Request.'
        };
      }, subjectCode);

      if (unbookStatus?.success) {
        await page.waitForTimeout(3000);
      }
    }

    // 4. Scrape BOTH Tables Cleanly (Left: Available to Book | Right: Already Booked)
    const backlogState = await wdFrame.evaluate(() => {
      const availableToBook = [];
      const alreadyBooked = [];

      const rows = Array.from(document.querySelectorAll('tr'));
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        // Look for rows containing a Subject Code like EC20005, CS21003, CS21001
        const codeIndex = cells.findIndex(c => /^[A-Z]{2,4}\d{4,5}$/.test(c));
        if (codeIndex === -1) continue;

        // If Subject Code is at index 3 (after Select, Internal, University Exam), it's in "Backlog Subject List"
        if (codeIndex >= 2 && cells.length >= 6) {
          const checkboxes = Array.from(tr.querySelectorAll('[role="checkbox"], [ct="CBX"], input[type="checkbox"]'));
          const isChecked = (el) =>
            el?.getAttribute('aria-checked') === 'true' ||
            el?.checked === true ||
            el?.innerHTML?.includes('checked');

          availableToBook.push({
            selected: isChecked(checkboxes[0]),
            internalAssessment: isChecked(checkboxes[1]),
            universityExam: isChecked(checkboxes[2]),
            subjectCode: cells[codeIndex],
            subjectName: cells[codeIndex + 1] || '',
            semester: cells[codeIndex + 2] || '',
            bookingType: cells[codeIndex + 3] || ''
          });
        } else {
          // Otherwise, it's in the right-hand "Booked Subject List" (e.g. CS21001)
          alreadyBooked.push({
            subjectCode: cells[codeIndex],
            subjectName: cells[codeIndex + 1] || '',
            semester: cells[codeIndex + 2] || '3rd Stage',
            bookingType: cells[codeIndex + 3] || 'Booked',
            rawColumns: cells.filter(Boolean)
          });
        }
      }

      return { availableToBook, alreadyBooked };
    });

    return res.json({
      serviceTitle: 'Backlog Booking',
      actionPerformed: action,
      unbookStatus,
      ...backlogState
    });

  } catch (err) {
    return res.status(500).json({ error: 'Backlog Booking failed', details: err.message });
  }
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON request body',
      details: err.message
    });
  }

  return next(err);
});

app.listen(4000, () => console.log('🚀 KIIT SAP Scraper Engine running on http://localhost:4000'));