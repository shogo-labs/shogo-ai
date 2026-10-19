import { Config } from '@remotion/cli/config';

Config.setEntryPoint('./src/index.ts');
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

// The Shogo runtime image ships Chromium at /usr/bin/chromium and exposes it
// as PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Rendering then reuses that browser
// instead of downloading Chrome Headless Shell on first render.
const browser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (browser) {
  Config.setBrowserExecutable(browser);
}
