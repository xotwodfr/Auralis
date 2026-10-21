import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { seriousViolations, trackAudio } from '../../shared/ui/testing/e2e-helpers'

// Two people chatting through the real chat server (server/chat + PostgreSQL), each in their own browser context, next to
// the mock Subsonic server. Needs E2E_CHAT_DATABASE_URL (see playwright.config.ts); skipped without it.

const MOCK = 'http://127.0.0.1:4599'
const CHAT = 'http://127.0.0.1:8791'
const PASSWORD = 'correct horse battery'
const run = Date.now().toString(36)

test.skip(!process.env.E2E_CHAT_DATABASE_URL, 'set E2E_CHAT_DATABASE_URL to run against a real chat server')

let ip = 0
/** Creates a chat account through the API; each sign-up comes from its own (proxy-reported) address. */
async function account(request: APIRequestContext, name: string) {
  const res = await request.post(`${CHAT}/api/v1/auth/register`, {
    data: { username: `${name}-${run}`, password: PASSWORD, displayName: `${name[0]!.toUpperCase()}${name.slice(1)} ${run}` },
    headers: { 'x-forwarded-for': `198.51.100.${++ip}` },
  })
  expect(res.status()).toBe(201)
  return (await res.json()) as { token: string; user: { id: string; username: string; displayName: string } }
}

async function person(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('https://lrclib.net/**', (route) => route.fulfill({ status: 404, body: '' }))
  await trackAudio(page)
  await page.goto('/')
  await page.getByLabel('Server address').fill(MOCK)
  await page.getByLabel('Username').fill('demo')
  await page.getByLabel('Password').fill('e2e-pass')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('heading', { name: 'Artists', level: 1 })).toBeVisible()

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Chat server' }).click()
  const section = page.getByRole('region', { name: 'Chat server' })
  await section.getByLabel('Chat server address').fill(CHAT)
  await section.getByRole('button', { name: 'Test address' }).click()
  await expect(section.getByRole('status')).toContainText('Connected')
  await section.getByRole('button', { name: 'Save address' }).click()
  await section.getByLabel('Username').fill(`${name}-${run}`)
  await section.getByLabel('Password').fill(PASSWORD)
  await section.getByRole('button', { name: 'Sign in' }).click()
  await expect(section.getByText('Connected', { exact: true })).toBeVisible()
  return page
}

const openChat = async (page: Page) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Social/ }).click()
  await page.getByRole('navigation', { name: 'Social' }).getByRole('link', { name: /^Chat/ }).click()
}

test('two people exchange direct and group messages live; offline sends arrive once; the Subsonic room still works', async ({ browser, request }) => {
  await account(request, 'alice')
  const bob = await account(request, 'bob')
  const alice = await person(browser, 'alice')
  expect(await seriousViolations(alice)).toEqual([])
  const bobPage = await person(browser, 'bob')

  // Alice starts a direct conversation with Bob.
  await openChat(alice)
  await expect(alice.getByRole('link', { name: /^Everyone on/ })).toBeVisible() // the Subsonic room is still there
  await alice.getByRole('button', { name: 'New message' }).click()
  const dialog = alice.getByRole('dialog', { name: 'New message' })
  await dialog.getByLabel('Who do you want to message?').fill(`bob-${run}`)
  await dialog.getByRole('button', { name: new RegExp(bob.user.displayName) }).click()
  await expect(alice).toHaveURL(/\/social\/chat\/c\//)
  await alice.getByLabel(`Message ${bob.user.displayName}`).fill('hi bob')
  await alice.getByLabel(`Message ${bob.user.displayName}`).press('Enter')
  await expect(alice.getByRole('log', { name: 'Messages' })).toContainText('hi bob')

  // Bob sees it arrive without reloading, with an unread badge, and answers.
  await openChat(bobPage)
  const fromAlice = bobPage.getByRole('link', { name: new RegExp(`^Alice ${run}, 1 unread`) })
  await expect(fromAlice).toBeVisible()
  await fromAlice.click()
  await expect(bobPage.getByRole('log', { name: 'Messages' })).toContainText('hi bob')
  await bobPage.getByLabel(`Message Alice ${run}`).fill('hi alice')
  await bobPage.getByLabel(`Message Alice ${run}`).press('Enter')
  await expect(alice.getByRole('log', { name: 'Messages' })).toContainText('hi alice')
  expect(await seriousViolations(bobPage)).toEqual([])

  // Offline: the send waits, then goes out once when the connection is back.
  await alice.context().setOffline(true)
  await alice.getByLabel(`Message ${bob.user.displayName}`).fill('sent while offline')
  await alice.getByLabel(`Message ${bob.user.displayName}`).press('Enter')
  await expect(alice.getByText(/Waiting for the connection|Sending/)).toBeVisible()
  await alice.context().setOffline(false)
  await expect(bobPage.getByRole('log', { name: 'Messages' }).getByText('sent while offline')).toHaveCount(1)
  await expect(alice.getByText(/Waiting for the connection|Sending/)).toHaveCount(0)

  // A group: Bob is added and sees it appear live.
  await alice.getByRole('button', { name: 'New group' }).click()
  const group = alice.getByRole('dialog', { name: 'New group' })
  await group.getByLabel('Group name').fill(`Band ${run}`)
  await group.getByLabel('Add people').fill(`bob-${run}`)
  await group.getByRole('button', { name: new RegExp(bob.user.displayName) }).click()
  await group.getByRole('button', { name: 'Create group' }).click()
  await alice.getByLabel(`Message Band ${run}`).fill('welcome to the band')
  await alice.getByLabel(`Message Band ${run}`).press('Enter')
  const bandForBob = bobPage.getByRole('link', { name: new RegExp(`^Band ${run}`) })
  await expect(bandForBob).toBeVisible()
  await bandForBob.click()
  await expect(bobPage.getByRole('log', { name: 'Messages' })).toContainText('welcome to the band')

  // Someone outside the conversation can't open it, even with its URL.
  const carol = await account(request, 'carol')
  const conversationId = /\/social\/chat\/c\/([^/]+)/.exec(alice.url())![1]
  const peek = await request.get(`${CHAT}/api/v1/conversations/${conversationId}/messages`, { headers: { authorization: `Bearer ${carol.token}` } })
  expect(peek.status()).toBe(404)

  // The Subsonic room is untouched by all of this.
  await alice.getByRole('link', { name: /^Everyone on/ }).click()
  await expect(alice.getByRole('log', { name: 'Messages' })).toBeVisible()

  // Narrow window: one pane at a time, and a thread always has a way back to the list.
  const back = alice.getByRole('link', { name: 'All conversations' })
  await expect(back).toBeHidden()
  await alice.setViewportSize({ width: 390, height: 800 })
  const band = alice.getByRole('link', { name: new RegExp(`^Band ${run}`) })
  await expect(band).toBeHidden()
  await back.click()
  await band.click()
  await expect(alice.getByRole('log', { name: 'Messages' })).toContainText('welcome to the band')
  await expect(band).toBeHidden()
  await back.click()
  await expect(band).toBeVisible()
})
