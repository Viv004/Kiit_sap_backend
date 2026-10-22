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
    await page.goto('https://kiitportal.kiituniversity.net/irj/portal', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    await page.fill('input[name="j_user"], #logonuidfield', rollNo);
    await page.fill('input[name="j_password"], #logonpassfield', password);
    await page.click('input[type="submit"], input[name="uidPasswordLogon"]');

    await page.waitForSelector('#welcome_message', { timeout: 20000 });
    const welcomeBanner = await page.locator('#welcome_message').innerText();
    const studentName = welcomeBanner.replace(/Welcome|\./gi, '').trim();

    await page.locator('#navNodeAnchor_1_1').click();

    const innerFrame = page.frameLocator('#ivuFrm_page0ivu3');
    await innerFrame.getByText('Student Self Service').first().click().catch(() => {});
    await innerFrame.getByText('Student Attendance Details').first().waitFor({ state: 'visible', timeout: 20000 });

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
 * 2. DYNAMIC SERVICE ROUTER (Universal Scraper for ALL pages)
 * POST /api/service
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
        const key = text.replace(/:\s*$/, '').trim();
        const knownProfileField = /^(school|school code|hostel|hostel name|hostel block|hostel details|room no\.?|room number)$/i.test(key);
        if ((text.endsWith(':') || knownProfileField) && key.length > 0 && key.length < 40) {
          const valueCell = cells[i + 1];
          const valueControl = valueCell?.querySelector('input:not([type="hidden"]), textarea, select');
          const nextVal = normalizeText(valueControl?.value || valueCell?.innerText || '');
          if (nextVal && !nextVal.endsWith(':') && nextVal.length < 100) {
            metadata[key] = nextVal;
          }
        }
      }

      const cleanTables = Array.from(document.querySelectorAll('table')).map(table =>
        Array.from(table.querySelectorAll('tr'))
          .filter(tr => !tr.querySelector('tr'))
          .map(tr => Array.from(tr.children)
            .filter(cell => /^(TD|TH)$/.test(cell.tagName))
            .map(cell => normalizeText(cell.innerText)))
          .filter(row => row.some(Boolean))
      ).filter(table => table.length > 0);

      const headerIndexes = (header) => {
        const find = (pattern) => header.findIndex(cell => pattern.test(cell));
        return {
          subject: find(/subject/i),
          absent: find(/absent/i),
          present: find(/present/i),
          percentage: find(/percentage|percent|attendance\s*%/i),
          totalDays: find(/total.*days|no\.?\s*of\s*days/i),
          facultyId: find(/faculty.*(id|code)/i),
          facultyName: find(/faculty.*name/i),
          excuses: find(/excuse/i)
        };
      };
      const attendanceTable = cleanTables.find(table =>
        table.some(row => {
          const columns = headerIndexes(row);
          return columns.subject >= 0 && columns.present >= 0 &&
            columns.percentage >= 0 && columns.totalDays >= 0;
        })
      );

      const numberAt = (row, index) => {
        if (index < 0 || !row[index]) return null;
        const parsed = Number.parseFloat(row[index].replace(/,/g, '').replace('%', ''));
        return Number.isFinite(parsed) ? parsed : null;
      };
      let attendance = [];

      if (attendanceTable) {
        const headerIndex = attendanceTable.findIndex(row => {
          const columns = headerIndexes(row);
          return columns.subject >= 0 && columns.present >= 0 &&
            columns.percentage >= 0 && columns.totalDays >= 0;
        });
        const columns = headerIndexes(attendanceTable[headerIndex]);
        attendance = attendanceTable.slice(headerIndex + 1).map(row => ({
          subject: row[columns.subject] || '',
          absent: numberAt(row, columns.absent),
          present: numberAt(row, columns.present),
          percentage: numberAt(row, columns.percentage),
          facultyId: columns.facultyId >= 0 ? row[columns.facultyId] || '' : '',
          totalDays: numberAt(row, columns.totalDays),
          facultyName: columns.facultyName >= 0 ? row[columns.facultyName] || '' : '',
          excuses: numberAt(row, columns.excuses) ?? 0
        }));
      } else {
        const selectionText = /^(row selected\.|to select a row,|row selection disabled\.)/i;
        const rows = Array.from(document.querySelectorAll('tr')).filter(tr => !tr.querySelector('tr'));
        attendance = rows.map(tr => {
          const values = Array.from(tr.children)
            .filter(cell => /^(TD|TH)$/.test(cell.tagName))
            .map(cell => normalizeText(cell.innerText))
            .filter(value => value && !selectionText.test(value));
          const subjectIndex = values.findIndex((value, index) =>
            index + 7 < values.length &&
            !Number.isFinite(Number.parseFloat(value)) &&
            [1, 2, 3, 4, 5, 7].every(offset => numberAt(values, index + offset) !== null)
          );
          if (subjectIndex < 0) return null;

          return {
            subject: values[subjectIndex],
            absent: numberAt(values, subjectIndex + 1),
            present: numberAt(values, subjectIndex + 2),
            percentage: numberAt(values, subjectIndex + 3),
            facultyId: values[subjectIndex + 4] || '',
            totalDays: numberAt(values, subjectIndex + 5),
            facultyName: values[subjectIndex + 6] || '',
            excuses: numberAt(values, subjectIndex + 7) ?? 0
          };
        }).filter(Boolean);
      }

      attendance = attendance.filter(row =>
        row.subject && !/^(total|overall|average)\b/i.test(row.subject) &&
        row.present !== null && row.totalDays !== null && row.totalDays > 0
      );

      if (attendance.length === 0) return { metadata, tables: cleanTables, attendance: [] };

      const totalPresent = attendance.reduce((sum, row) => sum + row.present, 0);
      const totalDays = attendance.reduce((sum, row) => sum + row.totalDays, 0);
      const overallAttendance = totalDays > 0 ? (totalPresent / totalDays) * 100 : null;

      return { metadata, attendance, overallAttendance };
    });

    return res.json({ serviceTitle, ...viewData });

  } catch (err) {
    return res.status(500).json({ error: `Failed to load ${serviceTitle}`, details: err.message });
  }
});

/**
 * 3. BACKLOG & GRADE IMPROVEMENT MANAGER
 * POST /api/backlog
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
    const innerFrame = page.frameLocator('#ivuFrm_page0ivu3');
    await innerFrame.getByText('Backlog Booking', { exact: false }).first().click();
    await page.waitForTimeout(3500);

    const wdFrame = await getWebDynproFrame(page);

    if (action === 'book' && subjectCode) {
      await wdFrame.evaluate(({ code, internal, uniExam }) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const targetRow = rows.find(tr => tr.innerText.includes(code));
        if (!targetRow) throw new Error(`Subject ${code} not found in Backlog Subject List`);

        const checkboxes = Array.from(
          targetRow.querySelectorAll('[role="checkbox"], [ct="CBX"], input[type="checkbox"], span.lsCBX--img')
        );

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

        toggleSapCheckbox(checkboxes[0], true);
        toggleSapCheckbox(checkboxes[1], internal);
        toggleSapCheckbox(checkboxes[2], uniExam);
      }, { code: subjectCode, internal: internalAssessment, uniExam: universityExam });

      await page.waitForTimeout(800);

      const submitBtn = wdFrame.locator('div[ct="B"], a[ct="B"], button, span').filter({ hasText: /Submit/i }).first();
      await submitBtn.click();
      await page.waitForTimeout(4000);
    }

    let unbookStatus = null;
    if (action === 'unbook' && subjectCode) {
      unbookStatus = await wdFrame.evaluate((code) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        const bookedRow = rows.find(tr => tr.innerText.includes(code));
        if (!bookedRow) {
          return { success: false, reason: `Subject ${code} not found in Booked Subject List.` };
        }

        const actionBtn = bookedRow.querySelector(
          'a, button, [ct="B"], [role="button"], [role="checkbox"], input[type="checkbox"], img[title*="Delete" i], img[title*="Remove" i], img[title*="Cancel" i]'
        );

        if (actionBtn) {
          actionBtn.click();
          return { success: true, method: 'sap_portal_button', message: `Clicked unbook control for ${code}` };
        }

        const allButtons = Array.from(document.querySelectorAll('[ct="B"], button, a.urBtnStd'));
        const globalUnbookBtn = allButtons.find(b => /(unbook|delete|remove|cancel|reset)/i.test(b.innerText));
        if (globalUnbookBtn) {
          bookedRow.click(); 
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

    const backlogState = await wdFrame.evaluate(() => {
      const availableToBook = [];
      const alreadyBooked = [];

      const rows = Array.from(document.querySelectorAll('tr'));
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
        const codeIndex = cells.findIndex(c => /^[A-Z]{2,4}\d{4,5}$/.test(c));
        if (codeIndex === -1) continue;

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