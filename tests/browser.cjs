// Shared browser setup for the browser checks.
// Playwright comes from the project's dev dependencies; PLAYWRIGHT_MODULE can
// point to another installation. CHROMIUM_EXECUTABLE picks a local Chromium;
// otherwise Playwright's full Chromium is used, which can load extensions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

function browserOptions(options = {}) {
  return {
    headless: true,
    ...options,
    ...(process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
      : { channel: 'chromium' })
  };
}

const launch = (options) => chromium.launch(browserOptions(options));

// Each run gets a new profile outside the project; closing the browser removes it.
async function launchWithProfile(options) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'viewing-assistant-test-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, browserOptions(options));
  } catch (error) {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
  const close = context.close.bind(context);
  context.close = async () => {
    try { await close(); } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); }
  };
  return context;
}

// Loads the unpacked extension from the project root.
const withExtension = (root, options = {}) => ({
  ...options,
  args: [...(options.args ?? []), `--disable-extensions-except=${root}`, `--load-extension=${root}`]
});

module.exports = { chromium, launch, launchWithProfile, withExtension };
