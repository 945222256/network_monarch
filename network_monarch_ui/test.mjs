import { chromium } from 'playwright';

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    page.on('console', msg => console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`));
    page.on('pageerror', error => console.error(`[Browser Error] ${error.message}`));
    
    await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
    
    // Wait a bit to see if there are any delayed errors
    await page.waitForTimeout(2000);
    
    await browser.close();
})();
