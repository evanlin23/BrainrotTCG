import { checkStagingAccess, stagingAccess } from './stagingAccess';

// globalSetup for playwright.staging.config.ts against real staging: stop before any spec when
// Cloudflare Access refuses the checks (docs/HOSTING.md#staging).
export default async function stagingAccessSetup(): Promise<void> {
  await checkStagingAccess(process.env.STAGING_URL!.replace(/\/*$/, '/'), stagingAccess());
}
