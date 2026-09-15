import {test,expect} from "@playwright/test";
test("operational incidents, capped email status and history are readable on desktop and mobile",async({page},testInfo)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/automation');
  const alerts=page.locator('#alerts');
  await expect(alerts.getByText('Needs your attention',{exact:true})).toBeVisible();
  await expect(alerts.locator('.incident-list').getByText('A provider charge needs reconciliation',{exact:true})).toBeVisible();
  await expect(alerts.getByText('Email alerts enabled',{exact:true})).toBeVisible();
  await expect(alerts.getByText(/At most 1 email attempt per UTC day/)).toBeVisible();
  await expect(alerts.getByText(/Acceptance does not confirm inbox delivery/)).toBeVisible();
  await alerts.locator('summary').click();await expect(alerts.getByText('Email accepted by provider',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('operational-alerts.png'),fullPage:true});
  await page.screenshot({path:testInfo.outputPath('incident-delivery-viewport.png')});
  await alerts.getByRole('link',{name:'View details →'}).first().click();await expect(page).toHaveURL(/jobs\?state=unknown/);
  expect(errors).toEqual([]);
});
test("empty dashboard explains that email is not configured",async({page})=>{
  await page.goto('http://127.0.0.1:4333/automation');
  await expect(page.getByText('No operational issues detected',{exact:true})).toBeVisible();
  await expect(page.getByText('Email alerts need setup',{exact:true})).toBeVisible();
});
